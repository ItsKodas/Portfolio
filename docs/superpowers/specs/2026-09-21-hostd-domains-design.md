# hostd domains design

Date: 2026-09-21
Status: approved, not implemented
Supersedes: the **Domains** section of `2026-09-20-hostd-design.md` (phase 4), which was written before
environments existed

## What this is

The design for hostd's domain half and the portal's Domains tab: the Apache vhost a client site is served
from, the certificate on it, the verification that proves a hostname reaches the right site, and the screen
that shows all of it.

Two existing designs already describe pieces of this and they disagree. `2026-09-20-hostd-design.md`
describes domains as a list per project with its own state store, `maxDomains: 3`, and a vhost per project.
`2026-09-20-hostd-provisioning-design.md`, written later, made a domain a single field on an environment
with a certificate mode beside it, and pulled vhost and certificate writing forward into provisioning. This
document reconciles them. Where they conflict, environments win, because that is the shape the registry,
the API and the portal were all actually built in.

Nothing of either is implemented today. `hostd/src` contains no vhost template, no Apache reload path, no
certificate handling and no domain endpoints. The registry records `domain` and `certificate` per
environment and hostd hands both to the portal, and nothing acts on either. Apache on the dedi is entirely
hand-written, exactly as the portal's placeholder copy says.

## Context

| | |
| --- | --- |
| Ingress | Apache2 on the host, not containerised, hand-written vhosts, 443 forwarded |
| Certificate today | One Cloudflare Origin CA certificate, covering the operator's own zones |
| Client domains | Mostly in the client's own registrar or Cloudflare, CNAMEd proxied to a hostname the operator keeps pointed at the dedi. Some are zones in the operator's Cloudflare account. |
| Sites affected | Five, all serving from hand-written vhosts today |
| `hostd-agent` | Root, holds the Docker socket, `network_mode: none`. It cannot reach the internet and cannot reload Apache. |
| `hostd-api` | Unprivileged, on the `hostd` network, holds the bearer token. It can reach the internet. |

Two constraints follow from that table and shape everything below.

**hostd can never reload Apache directly.** Apache runs on the host and the agent runs in a container with
no network. Something on the host has to do the reload, which means phase 4 introduces the first piece of
hostd that lives outside Docker.

**Verification has to be `api`'s job, not the agent's.** Proving a hostname reaches the right site means
fetching it over the internet, and the agent has no network at all. So the agent writes files and the
`api` container does the proving, which also settles where domain state lives.

## Scope

### In scope

- A host-side reload rail: a systemd path unit, a oneshot service, and the request and result handshake
- An Apache vhost per environment, rendered from a fixed template, written by the agent
- A primary hostname per environment plus aliases that redirect to it
- Verification of a hostname over https, its retry schedule, its states and its daily re-check
- Adopting a site that is currently served from a hand-written vhost, in one reload, reversibly
- Let's Encrypt certificates obtained through the same rail, and their renewal and expiry reporting
- The portal's Domains tab, readable by a client, actionable by the operator
- Health reporting, and an audit entry per action

### Not in scope

- Creating DNS records, or holding any Cloudflare API token. Domains are verified, never created.
- Changing an environment's primary hostname through the API. See **Decisions**.
- Wildcard certificates, which would need the DNS-01 challenge and therefore a registrar token
- Backups (phase 2) and general file access (phase 3), both unchanged by this
- The maintenance page's own contents, which the provisioning design owns. This design only renders the
  vhost rules that serve it.
- Per-hostname certificates for domains the operator does not control and cannot get a challenge through.
  If the client's proxy will not pass the ACME challenge, that domain stays on the Origin certificate.

## Decisions

Each was made explicitly with the operator on 2026-09-21.

**A primary hostname plus aliases, not a flat list.** Each environment keeps its existing `domain` as the
canonical hostname and gains an `aliases` list. Aliases are served, and they 301 to the primary rather than
serving the same content at a second URL. This is what real sites want (`www` and parked spellings) and it
avoids splitting a site across two addresses, which search engines and cookies both dislike. `maxDomains`,
which has never meant anything, now caps primary plus aliases together.

**hostd drives certbot.** The host rail gains a certificate verb, so a domain goes from verified to holding
its own Let's Encrypt certificate without anyone typing a command. This is what moves client-owned zones
from Full to Full (strict), which the original design named as a known weakness and listed as the upgrade
path. The alternative considered was hostd reporting and the operator issuing by hand; it was rejected
because the rail has to exist anyway, and a certificate verb on it is incremental.

**Existing sites are adopted, in one reload each.** hostd renders its own vhost and the host unit moves the
hand-written file aside in the same reload, so there is no window where neither file is serving. The old
file is moved, never deleted, so undo is a move back. The alternative considered was the original design's
hand migration, where the operator deletes the hostname from the hand-written vhost and adds it through
hostd, which costs a few seconds of 503 per site and offers no preview.

**Clients read, the operator acts.** A client sees their site's domains, whether each is working and what is
wrong when one is not. Adding, removing and adopting are the operator's. This matches how Deploys already
works, and it is why the Domains tab stops being hidden from clients.

**Changing the primary hostname is not an endpoint.** It is rare, it is destructive, and it is already
fixable by hand-editing the registry, which takes effect within ten seconds. An endpoint used once a year
is an endpoint whose edge cases are wrong when it is used.

**Two build phases, split at the certificate.** 4a is the rail and everything riding it on the certificate
that already exists; 4b adds certbot. After 4a every site serves a hostd-written vhost presenting the same
Origin certificate it presents today, so 4a changes who writes the file without changing what visitors get.
The adopt step, which is the risky one, therefore lands in a phase where rolling back means re-enabling a
file that is still on disk.

## Architecture

### The host rail

A new directory, `/etc/hostd/apache/`, is bind-mounted into `hostd-agent`. It holds `request.json` and
`result.json` and nothing else. The agent also gains `/etc/apache2/hostd/` read-write (its own include
directory, which Apache is configured to `IncludeOptional`) and `/etc/apache2/sites-enabled/` **read-only**,
which it needs in order to refuse a hostname another vhost already claims.

The handshake:

1. The agent writes `request.json` by atomic rename, carrying an action, its arguments, and a sequence
   number from a monotonic counter in agent state.
2. A systemd `PathExists=` unit on the host fires a oneshot service.
3. The service performs the action, runs `apache2ctl configtest`, reloads Apache only if the test passes,
   writes `result.json` carrying the same sequence number and Apache's own output, then deletes
   `request.json`, which re-arms the path unit.
4. The agent polls for a result whose sequence matches its own, for up to 30 seconds. Results carrying an
   older sequence are ignored, which is what makes a stale result from a previous request harmless.

Only one request is in flight at a time: the agent holds an in-process lock, and the host unit is a oneshot,
so systemd will not run two.

**The host unit is deliberately stupid.** It is a shell script and two unit files, it is the one piece that
cannot run in CI, so it is given no logic worth testing: perform, configtest, reload, report. It has exactly
two actions, `reload` and `adopt` (and `certificate` in 4b), and it validates nothing, because everything it
is handed was already validated by the agent.

**Reverting is the agent's job.** On a failed configtest nothing has reloaded, so the running configuration
is still the good one, but a bad file left on disk would be picked up by the next unrelated reload or by a
reboot. The agent knows the previous contents, so it restores them and triggers again to confirm the
configuration is clean. A revert whose own configtest fails is a health alarm, not a retry: something is
wrong that hostd did not cause and cannot fix.

### The vhost

One file per environment, `/etc/apache2/hostd/<id>-<env>.conf`. Per environment rather than the original
design's per project, because each environment has its own hostname, its own port and its own certificate.

Rendered from a fixed template. The only values substituted are validated hostnames, the environment's port,
the verification token, the maintenance key `<id>-<env>`, and the certificate paths. It contains:

- A `:80` block for the primary and every alias, serving `/.well-known/acme-challenge/` from a shared ACME
  webroot, serving the verification token, and redirecting everything else to the primary over https.
- A `:443` block for the primary: the certificate, the maintenance rules (serve the holding page with a 503
  and `Retry-After` when `/run/hostd/maintenance/<id>-<env>` exists or the upstream cannot be reached), then
  the proxy to `127.0.0.1:<port>`.
- A `:443` block for the aliases, which does nothing but 301 to the primary.

**The verification token needs no file on disk.** It is a `<Location /.well-known/hostd/<token>>` in the
template returning 204 with the token in a response header, so the whole proof lives in the one file Apache
already has to be given, and there is no second artefact to write, clean up or get out of step.

### The registry

One new key per environment, beside the existing `domain`:

```yaml
environments:
  live:
    dir: /var/www/pmpc-group
    branch: main
    domain: pmpcgroup.com.au
    aliases: [www.pmpcgroup.com.au]
    port: 5008
    certificate: letsencrypt
```

`aliases` is a list of hostnames, each validated exactly as `domain` is: converted to punycode and
lowercased, matching `HOSTNAME`, not at or below a `reserved` entry, not equal to the environment's own
primary, not held by another project or environment, and not claimed by any `ServerName` or `ServerAlias`
in `sites-enabled` that hostd has not adopted. Primary plus aliases together must not exceed `maxDomains`,
default 3. An absent `aliases` key means none, so every entry that exists today stays valid unchanged.

**The reserved carve-out.** Live verification on the dedi needs a hostname hostd will accept, and
`horizons.gg` is reserved, so everything under it is refused by construction. Rather than editing `reserved`
for the duration of a test, the registry gains an `allowed` key:

```yaml
reserved: [horizons.gg]
allowed: [test.hostd.horizons.gg]
```

`allowed` holds **exact hostnames only, never subtrees**, and each one exempts only itself from the
`reserved` check. Every other rule still applies to it. Two names can never be exempted, and the parser
refuses the file if they appear: the apex `horizons.gg` itself, and anything at or below `dev.horizons.gg`,
which is where the mail stack lives. That refusal is in code rather than in the runbook, so the mail stack
cannot be reached through this door by a later typo.

### Domain state

Verification state changes every minute. The registry is hand-edited and polled every ten seconds, so
writing it there would fight the operator's editor for no gain. It lives instead in `api`'s `/state`, keyed
by hostname:

| Field | |
| --- | --- |
| `state` | `unmanaged`, `pending`, `active`, `failed` or `broken` |
| `token` | the verification token currently in the vhost |
| `checkedAt`, `attempts` | the retry schedule's own bookkeeping |
| `error` | the last failure, already translated |
| `vhost` | the last write's outcome and Apache's output if it failed |
| `certificate` | mode, `notAfter` and issuer, read off disk |

`api` owns this because `api` does the verifying, and the agent has no network. The agent stays a verb
executor: it writes files and reports what the host unit said. This differs from deploy state, which lives
in the agent because the deploy poller runs there, and the difference is for the same reason in reverse.

## The lifecycle of a domain

### States

`unmanaged` is where all five existing sites start: a hostname hostd can see in the registry and has not
been given control of. It is not a failure and it raises nothing. Adopting it is the only way out.

A hostname hostd writes a vhost for starts `pending`. Verification turns it `active`, or `failed` after 72
hours, from which the operator may retry. Active hostnames are re-verified daily; a failure turns one
`broken` and raises it to both the operator and the client, and **the vhost stays in place**, because a DNS
blip must not take a working site offline.

### Verification

Performed by `api`, with a 10 second timeout, no redirects followed, and a check of the token header. Which
scheme it uses depends on the environment's certificate mode, and that distinction is load-bearing rather
than cosmetic.

**`cloudflare-origin`: https, with certificate verification on.** This is the original design's check and it
proves the whole chain in one request: the name resolves, Cloudflare routes it, it reaches this dedi's
Apache, and Apache routes it to **this** environment's vhost rather than another one. The certificate being
validated is Cloudflare's own, which is real, so a TLS failure genuinely does mean the request met the
origin certificate directly and the CNAME is therefore not proxied.

**`letsencrypt`: http first, then https once the certificate exists.** A domain in this mode is pointed
straight at the dedi with no proxy in front, so before its certificate is issued there is no valid
certificate for `api` to validate, and an https check could never pass. Checking https first would deadlock:
the domain could not verify, so it could never reach the step that issues the certificate that would let it
verify. So the first check is `http://<hostname>/.well-known/hostd/<token>`, served by the `:80` block,
which proves the name reaches this Apache and this vhost. That is enough to issue against. Once the
certificate is in place the domain is re-checked over https with verification on, and it is that second
check, not the first, that makes it `active`.

In 4a every environment is `cloudflare-origin`, so only the first of these exists. The http path arrives
with 4b.

Retries run every minute for the first hour, then every fifteen minutes up to 72 hours.

### What the client is told

Three failures, three different sentences, because they have three different fixes:

| What happened | What the client reads |
| --- | --- |
| TLS error | The CNAME is not proxied, so the request met the origin certificate directly. Turn the proxy on. |
| NXDOMAIN | No record exists yet. Add the CNAME. |
| Wrong or missing token | The name points somewhere else. |

The first of those is only ever said about a `cloudflare-origin` domain. Saying it about a `letsencrypt`
domain would be telling a client to turn on a proxy they were deliberately told not to use.

For a proxied domain the instruction is the same in every case: CNAME the hostname to `ORIGIN_HOSTNAME`,
proxied, with Cloudflare SSL mode Full. Domains in the operator's own Cloudflare account follow the same
flow, with the operator adding the record.

## Adopting an existing site

Two calls, because this one touches a live client site.

**`GET /projects/:id/:env/adopt` previews and moves nothing.** It returns the hand-written file or files
currently claiming this environment's hostnames, verbatim, alongside the vhost hostd proposes to replace
them with, so the portal can show them side by side. It also lists every `ServerAlias` in the old file that
the registry does not know about, so adopting can carry those hostnames across into `aliases` rather than
silently dropping names that work today.

The preview is the only protection against a hand-written vhost doing something the template has no
equivalent for: a custom rewrite, basic auth, a bespoke error page. Detecting those reliably is not
possible, so the design does not pretend to. It shows the operator the whole file and requires a
confirmation that names the project back.

**`POST` is where the single reload happens, and the file moves are the host unit's.** This is a deliberate
exception to the rule that the host unit stays stupid. The alternative is a read-write mount of
`sites-enabled` in the agent, which puts every vhost on the machine inside the agent's blast radius,
including the operator's own and `mail/`'s. The `adopt` verb instead is bounded: write the new file, move
these named files aside, configtest, reload, and move them back if the test fails. It also has to be atomic
with the reload to be one reload at all, which the agent cannot arrange from outside the host.

The displaced file goes to `/etc/apache2/hostd-adopted/<name>.conf.bak`. It is never deleted. Undo is a move
back and a reload, and the runbook says so in those words.

A domain adopted this way is already live and already resolving, so its first verification should pass
within the minute. If it does not, that is real news rather than a slow DNS record: it means the hostname
was reaching Apache through something other than the file that was just replaced.

## Certificates

Per environment, as the provisioning design already established.

`cloudflare-origin` uses the existing shared Origin certificate. Nothing is issued and nothing expires
independently, and the hop from Cloudflare to the dedi is encrypted but not authenticated for a hostname in
someone else's zone.

`letsencrypt`, which phase 4b adds, obtains a certificate on the dedi for the primary and every alias
together. The host rail gains a `certificate` action running `certbot certonly --webroot` against the shared
ACME webroot the `:80` block already serves, with `--cert-name <id>-<env>` so the paths the template
substitutes are derivable. certbot's own timer renews. hostd reads `notAfter` off disk and reports it.

**The order of operations matters**, because a certificate cannot be issued for a hostname that is not yet
reachable, and a vhost cannot present a certificate that does not yet exist:

1. Write the vhost with the `:80` block and a `:443` block presenting the Origin certificate. Reload.
2. Verify the token over http, per **Verification** above. The domain stays `pending`.
3. Only then ask for the certificate, over the rail.
4. Rewrite the vhost with the new certificate paths. Reload.
5. Re-verify over https with certificate checking on. The domain becomes `active`.

A site is therefore serving throughout, first on the Origin certificate and then on its own. A failure at
step 3 or 4 leaves it on the Origin certificate and raises an alarm, rather than leaving it on nothing. A
failure at step 5 means the certificate was issued but is not being served, which is the one outcome here
that needs the operator rather than the client.

A domain whose proxy will not pass the ACME challenge simply stays at step 2 with `cloudflare-origin` in
effect, and the tab says why.

## The API

All under one environment, with the old paths continuing to mean `live`, as every other endpoint already
does.

```
GET    /projects/:id/:env/domains                     list with state   (client-readable)
POST   /projects/:id/:env/domains      { hostname }   add an alias
DELETE /projects/:id/:env/domains/:hostname           remove an alias
POST   /projects/:id/:env/domains/:hostname/verify    retry verification now
GET    /projects/:id/:env/adopt                       preview the takeover
POST   /projects/:id/:env/adopt        { confirm }    take it over
```

One new policy verb, `domains-read`, is client-readable, alongside the existing `deploy-read`. Every other
verb here is admin-only. All of them require the project to carry the `domains` capability.

Removing an alias rewrites the vhost without it. Removing the primary is refused outright, so an environment
can never be left with no hostname: the only route to that is removing the environment itself.

## The portal

### The tab stops being hidden from clients

Today the Domains tab is built only for admins, in `app/(portal)/portal/sites/[id]/page.tsx`, with a comment
reasoning that domains will be the operator's to set and that promising a client a tab they will never be
given is the worse lie. That reasoning was correct for a tab with no read side. It stops being correct here,
so the gate goes and the tab joins Deploys as something a client may read about their own site. The
placeholder in `WAITING` goes with it.

### It keeps the environment selector

This is a correction to `2026-09-20-client-portal-screens-design.md`, which says backups and domains are not
per environment and that the selector therefore disappears on those tabs. That was true when a domain
belonged to a project. Environments own domains outright now, so Domains behaves exactly as Deploys does.

### What each side sees

The operator gets a table per environment: hostname, primary or alias, state, what it points at, when it was
last checked, and the certificate with its expiry. Unmanaged rows carry the adopt action, which opens the
side-by-side preview. Aliases can be added and removed, and a failing domain can be re-checked now.

The client gets sentences. Their domain, whether it is working, and, when it is not, which of the three
failures it is and whether the fix is theirs to make. No ports, no file paths, no vhost, no talk of Apache.

## Health and audit

Four things raise an alarm in `/health`:

- a domain in `broken`
- a vhost write that was rolled back
- a certificate inside 21 days of expiry, which only becomes meaningful in 4b
- **the host unit not answering**

The last is the one that matters most and is new to this design. If the systemd unit is dead, hostd cannot
change Apache at all, and every domain action will appear to hang rather than to fail. It has to be visible
in `/health` rather than only at the moment somebody tries something, so the agent reports the age of the
last successful handshake and goes unhealthy when a request times out.

Every add, remove, adopt and manual verification is audited with the actor and the user, as everything else
already is.

## Testing strategy

Ordinary unit tests cover hostname and alias validation including the `allowed` carve-out and its two
refusals, template rendering against golden files, the state machine and its retry schedule, the request and
result protocol including stale sequence numbers, the failure translation table, adopt's file moves and its
rollback, and the portal tab.

**The host unit gets none**, because a shell script and two systemd unit files cannot run in CI. Instead the
integration tests run a fake host unit: a small script implementing the same handshake, including a
configtest that can be told to fail. That covers the agent's entire half of the protocol and reduces the
genuinely untested surface to one question, "does systemd fire the path unit", which the runbook checks by
hand once.

On the dedi, in the runbook: the throwaway project at `/var/www/hostd-test`, a deliberately broken vhost to
watch the revert, live verification against `test.hostd.horizons.gg` through the `allowed` carve-out, and an
adopt of one real site with the undo exercised before any other site is touched.

## Build phases

| Phase | Covers |
| --- | --- |
| 4a | The host rail and its systemd units, the Apache include, the vhost template, `aliases` and `allowed` in the registry, domain state, verification, the endpoints, adopt, health, audit, and the portal tab, all on the existing Origin certificate |
| 4b | The `certificate` action, Let's Encrypt issuance and renewal, expiry reporting, and the certificate column's second half |

Each is its own implementation plan and its own PR.

## Known risks and accepted weaknesses

**The host unit is outside every test and every deploy path.** It reaches the dedi by hand, not by a merge
to `Master` and a `git pull`, so it can drift from the code that talks to it. The sequence number and the
handshake timeout are what make that drift visible rather than silent.

**Adopt cannot know what a hand-written vhost really did.** The preview shows the operator the file and asks
them to confirm; it does not understand it. A site with a custom rewrite will lose that rewrite, and hostd
will report success, because the vhost it wrote is valid and the site responds. The mitigation is that the
displaced file is kept and the undo is one move.

**Until 4b, client-owned zones stay Full rather than Full (strict).** This is the existing weakness carried
forward for one phase deliberately, so that adopt lands before certbot does.

**The `allowed` carve-out is a hole in the reserved rule.** It is narrowed as far as it can be (exact
hostnames only, never subtrees, with the apex and the mail subtree refused in code) but it is still a key
whose whole purpose is to permit something `reserved` exists to forbid. It should hold one entry, for the
test hostname, and a review should ask why if it ever holds more.

**A wildcard is impossible here.** `--webroot` does the HTTP-01 challenge, which cannot issue a wildcard.
Every hostname must be named, which is what `maxDomains` bounds.

## Later

Changing an environment's primary hostname through the API, if hand-editing the registry turns out to be
something that happens often enough to be worth an endpoint. Cloudflare for SaaS custom hostnames, which
would remove the per-hostname certificate problem entirely and is the successor to 4b rather than an
addition to it.
