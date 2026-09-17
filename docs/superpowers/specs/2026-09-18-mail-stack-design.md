# Self-hosted mail stack design

Date: 2026-09-18
Status: approved design, not yet implemented

## Context

The site (`horizons.gg`, a Next.js 15 app) currently has no backend of any kind: no database, no route
handlers, no server actions. The only server-side code is Next's build-time metadata generation.

The goal is a self-hosted mail stack that receives mail for the author's domain, running in Docker on
the author's own hardware. A contact form on the site is the eventual consumer, but site integration is
explicitly out of scope for this phase.

### The environment, measured

The stack runs behind a residential Telstra connection in Queensland, Australia. These facts were
measured rather than assumed, and they drive most of the design:

| Property | Finding |
| --- | --- |
| Outbound port 25 | Open. Google, Microsoft, Zoho and iCloud MX hosts all returned `220` banners. |
| Public IP at time of writing | `124.177.8.46`, in `124.177.0.0/18` |
| Reverse DNS | `cpe-124-177-8-46.qb10.qld.asp.telstra.net` |
| Forward-confirmed reverse DNS | **Fails.** The PTR name has no forward A record. |
| Spamhaus | Listed on PBL only. No SBL or XBL listing. |
| IP allocation | Dynamic |

Two consequences follow. PBL self-suppression requires a static address, so that listing is permanent.
And the PTR is owned by Telstra, cannot be changed on a residential plan, and does not forward-confirm.
Direct outbound delivery to Gmail and Microsoft is therefore a weak bet, and the design treats the
outbound relay as a first-class switch rather than an afterthought.

Inbound is unaffected by any of this. Receiving mail has no reputation requirement.

## Scope

### In scope

- Receiving mail for `dev.horizons.gg` and forwarding it to an existing inbox
- Domain-driven auto-configuration: one parameter in, a full DNS record set out
- Cloudflare DNS reconciliation, including dynamic-IP tracking
- Certificate acquisition via ACME DNS-01
- Continuous health assertion appropriate to an address the operator does not control
- A delivery-target seam that a future database ingestion service plugs into

### Not in scope

- Mailboxes, IMAP, POP3, webmail, mail storage or backups
- Any database, schema or migration
- Any change to the site: no route handlers, no contact form, no server-side code
- Outbound mail originating from the site (the contact form is a later phase)
- Serving domains other than `dev.horizons.gg`

## Decisions

Each decision below was made explicitly, with the reasoning that produced it.

**Forward-only, no mailboxes.** Mail is accepted and forwarded to an inbox the author already uses.
This removes Dovecot's storage, IMAP exposure, backup requirements and the port 993 forward. The cost
is that every received message triggers an outbound delivery, which means the outbound path matters
from day one rather than only when the contact form arrives.

**Mail domain is `dev.horizons.gg`.** Addresses read `contact@dev.horizons.gg`. The apex stays free for
Cloudflare Email Routing or anything else, and reputation experiments on an unproven IP stay off the
main domain. The server hostname is derived as `mail.dev.horizons.gg`.

**Separate compose file in this repo, at `mail/docker-compose.yml`.** Versioned alongside the site so a
future contact form can reference it, but deployed independently so a mail config error or restart
never touches the site.

**Built on `docker-mailserver`, with a small custom operator.** The component where mistakes are
expensive and silent is Postfix, above all the open-relay failure mode. `docker-mailserver` ships a
configuration that a lot of people have audited. Custom code is confined to the part that is genuinely
specific to this situation: domain-driven configuration, Cloudflare reconciliation, and health
assertion on an address that changes underneath it.

Rejected alternatives: hand-rolled Postfix plus Rspamd plus postsrsd, which saves a container nobody
notices at runtime while taking on correctness ownership of the one component where correctness is
hard; and Mailu or Mailcow, which assume mailboxes, users and an admin UI, and in Mailcow's case
require MySQL and Redis and are explicitly unhappy behind a dynamic IP.

**Direct outbound by default, relay behind one variable.** Setting `RELAY_HOST` switches outbound to an
authenticated transactional relay. Deliverability is then measured rather than argued about, and the
fallback costs nothing to carry.

**OpenDKIM signs, Rspamd filters.** Rspamd can sign, but OpenDKIM's key file location is stable and
documented, and the operator's DKIM publication handshake depends on reading that file. Running one
signer avoids double-signing.

## Architecture

### Containers

Two services on a dedicated Docker network.

**`mailserver`** is stock `docker-mailserver`. It owns everything that touches SMTP: Postfix, OpenDKIM,
Rspamd, postsrsd, Fail2ban. It is configured, never modified.

**`mailops`** is custom and small. It never touches mail. It talks to the Cloudflare API, runs health
probes against the public internet, reads the DKIM public key from a shared volume, and maintains TLS
certificates. It runs a reconciliation loop rather than a one-shot bootstrap.

### Ports

Exactly one port is published: **25/tcp**, forwarded on the modem.

- No 587. The only future sender is the site container, reachable over the Docker network.
- No 143 or 993. There are no mailboxes.
- No 80 or 443. Certificates come from ACME DNS-01, so there is no HTTP challenge to serve and no
  renewal that breaks when the IP rotates.

Outbound 25 must remain open, and was confirmed open.

### Mail flow

```
inbound:
  internet ──25──► Postfix ──► Rspamd ──► virtual alias ──► delivery target
                                 │                               │
                              (junk)                         forward
                               drop                              │
outbound:                                                        ▼
  Postfix ──► direct to recipient MX          (default)
          └─► RELAY_HOST with SMTP auth       (when RELAY_HOST is set)
```

Forwarded mail is SRS-rewritten on the envelope sender. Without SRS, forwarding a message whose SPF
authorises Gmail, out of a Telstra address, fails SPF at the receiving end. `ENABLE_SRS=1` with
`SRS_SENDER_CLASSES=envelope_sender`.

### Volumes

`mail-data` holds the Postfix queue, DKIM keys, Rspamd state and SRS secret. The queue is load-bearing:
it is what retries when a forward target is unreachable, and what will hold mail during a database
outage in a later phase.

`mail-config` holds the `docker-mailserver` config directory, principally the virtual alias map and the
OpenDKIM keys. `mailops` mounts it read-write, with a strict ownership split: it reads the DKIM public
key, which `mailserver` owns, and it writes the generated virtual alias map, which `mailops` owns and
`mailserver` only reads. Neither container writes a file the other owns.

`mail-certs` holds ACME-issued certificates, written by `mailops` and read by `mailserver` with
`SSL_TYPE=manual`.

## DNS and auto-configuration

`MAIL_DOMAIN=dev.horizons.gg` is the single input. The hostname (`mail.dev.horizons.gg`), the record
set, the HELO name and the SPF content are all derived from it plus the current public IP, the DKIM
public key, and whether a relay is configured.

### Managed records

| Record | Value | Notes |
| --- | --- | --- |
| `mail.dev` A | current public IP | `proxied: false`, 60s TTL |
| `dev` MX | `mail.dev.horizons.gg`, priority 10 | |
| `dev` TXT | SPF, computed | see below |
| `mail._domainkey.dev` TXT | DKIM public key | read from `mail-config` |
| `_dmarc.dev` TXT | `v=DMARC1; p=none; rua=mailto:$DMARC_RUA` | starts permissive |

`proxied: false` is mandatory on the A record. Cloudflare's proxy is HTTP only, and a proxied mail host
silently breaks SMTP.

### Computed SPF

SPF is derived rather than fixed, because it must change when the relay switch is flipped. Forgetting
to update SPF when adding a relay is a common way to break mail that was previously working.

- No relay: `v=spf1 a:mail.dev.horizons.gg ~all`
- With relay: `v=spf1 a:mail.dev.horizons.gg include:<relay SPF domain> ~all`

The relay's SPF include is supplied as `RELAY_SPF_INCLUDE` alongside the relay credentials.

### Deliberately permissive start

SPF ends `~all` and DMARC starts at `p=none`. Given an unproven IP with a known-imperfect reverse DNS
situation, a soft fail that is visible in DMARC reports is more useful than a hard fail that silently
drops mail. Tightening to `-all` and `p=quarantine` is a deliberate later step once reports show what
actually delivers.

### The `managed-by` guard

This is the most important safety property in the design.

The Cloudflare token can edit every record in the `horizons.gg` zone, including those serving the live
site. A reconciler bug combined with a delete call is how a mail change takes the site down.

Every record `mailops` creates carries the Cloudflare record comment `managed-by:mailops`. The
reconciler will only ever update or delete records carrying that stamp. Unstamped records are read and
left alone. A conflicting unstamped record at a name the reconciler wants is surfaced as an error, never
adopted and never overwritten. The site's records are structurally out of reach.

The token is scoped to `Zone:DNS:Edit` on `horizons.gg` only. `CF_ZONE_ID` is supplied explicitly so
the token does not additionally need `Zone:Read`.

### The DKIM handshake

`mailserver` generates the OpenDKIM keypair on first start and writes it into `mail-config`. `mailops`
polls for the key file, and publishes the public half once it appears. Neither container orchestrates
the other, and a wiped volume regenerates and republishes without intervention.

### Certificates

`mailops` obtains and renews a certificate for `mail.dev.horizons.gg` via ACME DNS-01, using the same
Cloudflare token, and writes it to `mail-certs`. `mailserver` runs `SSL_TYPE=manual` pointing at those
files. DNS-01 is used specifically because it requires no inbound HTTP and does not break when the
public IP rotates.

## The mailops reconciliation loop

Declarative, not a one-shot bootstrap. The same code path that performs initial setup is the one that
repairs state after an unattended IP change.

Each cycle, at a 60 second interval:

1. Determine the current public IP.
2. Compute the desired record set from `MAIL_DOMAIN`, the current IP, the DKIM key and the relay config.
3. Upsert each desired record, respecting the `managed-by` guard. Idempotent: no change means no API call.
4. If the IP changed since the last cycle, re-run the Spamhaus check immediately.
5. Renew the certificate if it is within its renewal window.
6. Run the continuous health assertions and update the healthcheck state.

Re-checking Spamhaus on IP change matters because a rotated address can arrive carrying a previous
occupant's XBL listing. That is a condition the operator needs to learn about from a log line, not from
mail mysteriously failing.

## Delivery seam

Postfix resolves `contact@dev.horizons.gg` through a virtual alias map generated by `mailops` from
configuration. `DELIVERY_TARGETS` is a list, `forward` in this phase, `forward,ingest` in a later one.

The contract is fixed now, because it determines whether the database phase can lose mail. A delivery
target receives the raw RFC822 message and answers with an exit code:

- **0**: accepted, Postfix considers delivery complete.
- **75** (`EX_TEMPFAIL`): retry later, Postfix requeues.

A future ingestion service returning 75 when it cannot reach the database turns an outage into a retry
rather than a loss. This convention is cheap to establish now and awkward to retrofit.

Only `forward` is implemented in this phase. It is a plain virtual alias to `FORWARD_TO`, SRS-rewritten.

## Health assertion and failure behaviour

Two tiers, split on a single principle: **never fail closed on a condition whose failure mode is lost
mail.**

### Hard gate at boot

Configuration errors knowable before accepting anything, where starting up is worse than not. Exit
non-zero, naming the specific check that failed.

- `MAIL_DOMAIN` missing or malformed
- `FORWARD_TO` unset
- Cloudflare token rejected, or `CF_ZONE_ID` invalid
- Outbound port 25 unreachable, tested by connecting to a known MX and reading its banner
- Public IP undeterminable

### Degrade and shout

Environmental conditions that change on their own. Logged loudly, healthcheck flipped unhealthy, MTA
keeps running.

- Inbound port 25 unreachable
- New Spamhaus listing after an IP rotation
- Forward target bouncing or refusing
- DNS drifted from desired state, or an unstamped record blocking reconciliation
- Certificate approaching expiry with renewal failing

If the stack killed itself because inbound 25 went away, nothing is received while it is down. If it
stays up and complains, receiving resumes the moment the port returns, and the Postfix queue covers the
gap.

### Testing inbound 25 honestly

Inbound reachability cannot be self-tested from inside the network, because NAT loopback reports
success regardless. At boot, `mailops` performs an external port check as informational output only.
For ongoing evidence it tracks the timestamp of the last successful inbound SMTP connection from
Postfix's logs and warns on staleness. That is real evidence with no third-party dependency in the
steady state.

All output goes to container logs and the Docker healthcheck. Not email alerts, for the obvious
circular reason.

## Configuration surface

A single gitignored `mail/.env`, with a committed `mail/.env.example`:

```
MAIL_DOMAIN=dev.horizons.gg
FORWARD_TO=you@example.com
CF_API_TOKEN=...
CF_ZONE_ID=...
DMARC_RUA=you@example.com
DELIVERY_TARGETS=forward

# leave RELAY_HOST empty for direct delivery
RELAY_HOST=
RELAY_PORT=587
RELAY_USER=
RELAY_PASSWORD=
RELAY_SPF_INCLUDE=
```

`.gitignore` already covers `.env*`. `.dockerignore` currently lists only `.next/` and `node_modules/`,
and gains `.env*` so a stray env file can never be copied into the site image.

These are the stack's own variables. The compose file maps them onto `docker-mailserver`'s variables:
`OVERRIDE_HOSTNAME`, `ENABLE_SRS`, `SRS_SENDER_CLASSES`, `ENABLE_RSPAMD`, `ENABLE_OPENDKIM`,
`ENABLE_FAIL2BAN`, `ENABLE_IMAP=0`, `ENABLE_POP3=0`, `SSL_TYPE=manual`, and the relay set.

The relay uses `RELAY_HOST`, `RELAY_PORT`, `RELAY_USER` and `RELAY_PASSWORD`, not `DEFAULT_RELAY_HOST`.
`docker-mailserver` applies `RELAY_HOST` to every configured domain and it is the form that carries SASL
credentials, which an authenticated transactional relay requires. `DEFAULT_RELAY_HOST` sets Postfix's
`relayhost` directly without an associated credential pair, so it is not used here.

## Testing strategy

**Pure logic, unit tested.** Desired-state computation is most of `mailops` and needs no network: SPF
derived from relay configuration, record set derived from domain and IP, hostname derived from
`MAIL_DOMAIN`.

**The `managed-by` guard, tested explicitly.** There must be a test asserting the reconciler refuses to
modify or delete an unstamped record. This is the one bug that could take the live site down.

**Reconciler against a mocked Cloudflare API**, covering: first run on an empty zone, IP change, DKIM
key appearing after several cycles, a conflicting unstamped record, and a no-op cycle making zero write
calls.

**Open relay verification, before anything else goes live.** Non-negotiable. Once 25 is forwarded,
immediately run an external relay test and confirm the server refuses mail for domains it does not own.
If it fails, close the port on the modem and fix it before reopening. An open relay on a residential IP
is found within hours and the consequences outlive the mistake.

**Inbound end to end.** Send from an external account to `contact@dev.horizons.gg`, confirm arrival at
`FORWARD_TO`, and confirm SRS rewrote the envelope sender.

**Deliverability, measured not assumed.** Send to mail-tester.com and read the score, which reports
reverse DNS, SPF, DKIM, DMARC alignment and blocklist status in one pass. That result, not speculation,
decides whether `RELAY_HOST` gets set.

## Known risks and accepted weaknesses

**Forward-confirmed reverse DNS does not close, and cannot.** HELO is `mail.dev.horizons.gg`, which has
a forward record the stack maintains. Reverse DNS stays Telstra's `cpe-...` name, which has no forward
record and is not changeable on a residential plan. Mitigation is the relay switch. The design does not
pretend otherwise.

**The PBL listing is permanent.** Self-suppression requires a static IP. Mitigation is the relay switch.
PBL does not affect inbound.

**Dynamic IP causes short inbound gaps.** The A record carries a 60s TTL and the reconciler runs every
60s, so worst-case exposure is roughly two minutes plus resolver caching. Sending servers retry for
days, so the practical impact on received mail is close to nil.

**A rotated IP can arrive with inherited reputation damage.** Handled by re-checking Spamhaus
immediately on IP change.

**The Cloudflare token can edit the live site's DNS.** Handled by the `managed-by` guard and by scoping
the token to `Zone:DNS:Edit` on one zone.

## Later phases

Out of scope here, recorded so the seam is built in the right shape.

1. **Database ingestion.** An `ingest` delivery target parses MIME and writes to a database. Requires
   decisions this design deliberately does not make: database choice, schema, attachment storage, and
   the site's first server-side code. The `EX_TEMPFAIL` contract above is what keeps it safe.
2. **Contact form.** A route handler on the site sending outbound through this stack over the Docker
   network. This is the point at which port 587 may become relevant internally.
3. **Tightening policy.** Moving SPF to `-all` and DMARC to `p=quarantine` once reports justify it.
