# Mail stack runbook

## Before first start

1. Create a Cloudflare API token scoped to **Zone:DNS:Edit on `horizons.gg` only**. Nothing else.
2. Copy `mail/.env.example` to `mail/.env` and fill in `MAIL_ADDRESS`, `FORWARD_TO` and `DMARC_RUA`.
3. Copy `mail/.env.mailops.example` to `mail/.env.mailops` and fill in `CF_API_TOKEN` and `CF_ZONE_ID`.
4. Do **not** forward port 25 on the modem yet.

Both files are gitignored. The split is deliberate and is a security boundary, not tidiness.

### Why the credentials live in a second file

`mail/.env` is read by both containers. `mail/.env.mailops` is read only by `mailops`.

The token can edit every DNS record in the `horizons.gg` zone, including the ones serving the live
site. The `mailserver` container terminates untrusted SMTP from the public internet and parses hostile
MIME through Rspamd, so it is the most likely component in this stack to be compromised, and it has no
use whatsoever for the Cloudflare values. Keeping them out of its environment is what bounds the blast
radius, alongside the `managed-by` guard.

**If a real token has ever been present in the `mailserver` container's environment, rotate it.** Moving
the value to a different file does not undo the exposure. Revoke the old token in the Cloudflare
dashboard, issue a new one with the same scope, and put the new value in `mail/.env.mailops`.

## First start

Bring the stack up, then create the mail account straight away, before watching the logs:

```bash
cd mail
docker compose up -d
docker compose exec mailserver setup email add info@dev.horizons.gg
docker compose logs -f mailops
```

The address must be `MAIL_ADDRESS@MAIL_DOMAIN` from `mail/.env`, so `info@dev.horizons.gg` with the
example values.

### Why the account, and why straight away

`docker-mailserver` refuses to run without at least one mail account. If none exists within two minutes
of starting, it shuts down and restarts. This stack is forward-only and has no use for a mailbox, but
the account is required anyway, so you create exactly one: the same address the server accepts.

You will be asked for a password. Choose any strong one you do not use elsewhere; **you will never need
it again.** Nothing ever logs in with this account: IMAP and POP3 are off, and port 587 is not published.
Its only job is to let `docker-mailserver` start.

Mail to the address is still forwarded, not stored. `mailops` writes an alias sending it to
`FORWARD_TO`, and Postfix applies the alias before delivery, so nothing piles up in a mailbox nobody can
open. The inbound end-to-end test below confirms this.

If you miss the two-minute window, `docker-mailserver` restarts. Run the `setup email add` command again
once it is back up. You only ever do this once: the account lives in the `mail-config` volume, survives
restarts, and is only needed again after wiping that volume.

Expect `boot gate passed` within a minute or two. If it exits instead, the log names the failed check.

The gate retries its environmental probes (outbound 25, the public IP lookup, reaching the Cloudflare
API) five times over about 75 seconds before giving up, logging each attempt. On a residential link
those three fail transiently often enough that exiting on the first bad answer would mean a
crash-looping `mailops`, a stale A record and, after the next IP rotation, inbound mail stopping. That
is the failure mode the whole design exists to avoid, so the gate waits.

A token Cloudflare actively rejects is different. That is genuine misconfiguration, retrying cannot fix
it, and the gate exits immediately saying so.

Then confirm the zone. `mail.dev.horizons.gg` A, `dev.horizons.gg` MX and TXT, and `_dmarc.dev.horizons.gg`
TXT should exist in Cloudflare, each commented `managed-by:mailops`, and the A record must be grey-clouded.

There is **no DKIM record yet**, and there will not be one until you do the next step. Do not wait for it.

You will also see `inbound 25 from outside: UNREACHABLE` in the log and an `inbound-unreachable` warning.
**That is correct at this point**, because you have not forwarded port 25 yet. It clears once you do,
in the open relay step below.

## Generate the DKIM key

`docker-mailserver` does **not** create an OpenDKIM keypair by itself. It has to be told to, once, and
it has to be restarted afterwards. Until you do this, OpenDKIM has no key, nothing is signed, and
`mail._domainkey.dev.horizons.gg` never appears no matter how long you wait.

This matters more here than it would elsewhere. On an address with no forward-confirmed reverse DNS and
a permanent PBL listing, DKIM is the only authentication signal this design can actually win.

**Wait until `mailops` has written the alias map before running this.** `setup config dkim` derives its
domain list from the accounts and virtual alias files, so running it before `mailops` has written
`postfix-virtual.cf` produces a key for no domains, or for the wrong ones. `mailops` writes that file
immediately after the boot gate passes, so seeing `boot gate passed` in the log is the signal to go.

```bash
cd mail
docker compose exec mailserver setup config dkim keysize 2048
docker compose restart mailserver
```

Then wait one reconcile cycle (60 seconds) and confirm `mail._domainkey.dev.horizons.gg` TXT now exists
in Cloudflare, commented `managed-by:mailops`. `mailops` polls for the key file and publishes the public
half on the first cycle it finds one, so no further action is needed.

If the record does not appear, check that the key was written:

```bash
docker compose exec mailserver cat /tmp/docker-mailserver/opendkim/keys/dev.horizons.gg/mail.txt
```

This step is needed again after wiping the `mail-config` volume, and only then. The key survives
ordinary restarts.

## Open relay verification, before the port stays open

This is the step that protects you from the expensive mistake. Do it immediately, not later.

1. Forward port 25 to the host on the modem.
2. Run an external relay test at once, through MXToolbox's SMTP diagnostic or mail-tester.
3. Confirm it reports **no open relay**.
4. Confirm inbound 25 is reachable from outside. Restart `mailops` so it checks straight away rather than
   waiting up to 15 minutes, then look for `inbound 25 from outside: reachable` in its log:

   ```bash
   docker compose restart mailops && docker compose logs -f mailops
   ```

If the test reports an open relay, close port 25 on the modem before doing anything else, then investigate.
An open relay on a residential address is found within hours and the consequences outlive the mistake.

If inbound 25 is still `UNREACHABLE` with the port forwarded, check the forward points at this machine's
LAN address. If it does, your ISP is probably blocking inbound 25, which a timeout cannot distinguish from a
missing forward. That would need raising with the ISP or a different way in; it is not something this
stack can work around.

### How the inbound check works

Inbound 25 cannot be tested from inside your own network, because the modem's loopback reports success
whether the port is open or not. So `mailops` asks check-host.net to connect to your public address on
port 25 from four nodes around the world. One node getting through counts as reachable, since any single
node can sit behind its own network's outbound-25 block. Every node failing counts as unreachable.
Anything in between, including check-host itself being down, counts as inconclusive and never as either
answer.

It runs at startup, whenever your public IP changes, and otherwise every 15 minutes. It is deliberately
not every cycle: it is a free third-party service, and calling it once a minute is the quickest way to get
blocked by it. check-host.net sees your public address, which is already public in your DNS.

It is loud, never fatal. An unreachable port turns the healthcheck unhealthy but never stops `mailops`,
because stopping it would stop the DNS updates, and on a dynamic IP that ends inbound mail entirely after
the next rotation.

## Inbound end to end

Send a message from an external account to `info@dev.horizons.gg`, then confirm:

- it arrives at `FORWARD_TO`, which also proves the alias is forwarding rather than the account's mailbox
  keeping it
- the envelope sender was SRS-rewritten, visible as `SRS0=` in the received headers

## Measure deliverability, do not assume it

Send a message to the address mail-tester.com gives you and read the score. It reports reverse DNS, SPF,
DKIM, DMARC alignment and blocklist status together.

Reverse DNS is expected to score badly. The address is Telstra's `cpe-...` name, it does not
forward-confirm, and it cannot be changed on a residential plan. That is a known, accepted weakness.

If delivery to real recipients disappoints, switch to a relay: set `RELAY_HOST`, `RELAY_PORT`, `RELAY_USER`,
`RELAY_PASSWORD` and `RELAY_SPF_INCLUDE` in `mail/.env`, then `docker compose up -d`. SPF updates itself on
the next reconcile cycle. No rebuild, no redesign.

## Certificates: renewal needs a manual restart

**This is currently a manual step, and skipping it eventually breaks TLS on the wire.**

`mailops` renews the certificate over ACME DNS-01 around day 60 and writes it into the `mail-certs`
volume. `mailserver` runs `SSL_TYPE=manual` and does not reliably notice a manually supplied certificate
changing on disk, so Postfix carries on presenting the old one until it expires around day 90, while the
file `mailops` checks looks perfectly healthy. Nothing in the stack restarts `mailserver` on its own.

It could: the operator container would only need the Docker socket. That was rejected deliberately. It
would hand the most privileged capability in the stack to the process that already holds a zone-edit
token, to save one command every two months. A documented manual step is the better trade.

So `mailops` tracks it instead. It records the expiry of the certificate on disk and the expiry the
operator last confirmed `mailserver` picked up, and it raises a `cert-reload-needed` warning, which
flips the healthcheck unhealthy, for as long as the two disagree. An expired-on-the-wire certificate
therefore cannot sit behind `ok: true`.

**After any certificate renewal, and once after the very first issuance:**

```bash
cd mail
docker compose restart mailserver
docker compose exec mailops npm run ack-cert
```

The first command makes Postfix load the new certificate. The second records that it happened, which
clears the warning. Run them together; acknowledging without restarting is lying to yourself, and the
next renewal will simply raise the warning again.

A `cert-renewal` warning is different: it means `lego` itself is failing. `mailops` backs off
exponentially rather than hammering Let's Encrypt's rate limits, and the rest of the cycle keeps running
and keeps reporting, so the Spamhaus and DNS checks stay visible while you investigate.

## Accepted addresses

The server accepts `MAIL_ADDRESS@MAIL_DOMAIN`, so `info@dev.horizons.gg` with the example values, and
nothing else. Mail to any other address at the domain is rejected at SMTP time, which is the correct
answer for a forward-only server.

To change the address, set `MAIL_ADDRESS` in `mail/.env`, then create a matching account with
`setup email add` as in First start. The account and the accepted address must agree.

`ACCEPT_CATCHALL=1` in `mail/.env` adds `@dev.horizons.gg` to the alias map, accepting every address at
the domain. Think before turning it on. On a forward-only server a catch-all means every
dictionary-attack recipient is accepted and immediately re-sent to `FORWARD_TO` from an address that is
permanently on the PBL. The likely outcome is your own provider rate-limiting or filtering the one
delivery path this design depends on. The upside is only that a typo'd address still reaches you.

After changing it, `docker compose up -d` and wait one cycle for `mailops` to rewrite the alias map.

## Day to day

- Health: `docker compose ps` shows `mailops` healthy or unhealthy, and `/health/status.json` holds the detail.
- Warnings: `docker compose logs mailops | grep WARN`.
- A `dns-conflict` warning means something unmanaged sits at a name we want. Nothing is overwritten. Remove
  the conflicting record by hand, or rename ours.
- A `cert-reload-needed` warning means the certificate on disk is not the one `mailserver` is serving.
  See the certificates section above. Left alone, TLS on the wire expires.
- A `cert-renewal` warning means `lego` is failing. The rest of the cycle still ran and still reported.
- A `log-unreadable` warning means `MAIL_LOG_FILE` does not point at a readable file, so the
  inbound-staleness check, the only real evidence inbound 25 works, is not running. Check the path and
  the `mail-logs` mount.
- A `dns-write-loop` warning means a record was rewritten on three consecutive cycles with unchanged
  desired content and never came back matching, so `mailops` stopped writing it rather than PATCH the
  production zone forever. The named record is now stale. Compare the desired value against what
  Cloudflare actually holds and work out why the two never agree. This is a `mailops` bug, not an
  operator mistake, and the stack stays up while you look at it.
- A `spamhaus` warning after an IP change means the new address arrived with inherited reputation damage.
  Switching to a relay is the remedy.
- An `inbound-unreachable` warning means no outside node could connect to your port 25. Usually the
  modem's port forward, often lost after a modem reboot. See the open relay section for diagnosis.
- An `inbound-check-unavailable` warning means the outside check has been inconclusive three times
  running, so inbound 25 is currently unverified rather than known good. Usually check-host.net being
  unreachable. It does not mean the port is closed.
- An `inbound-stale` warning means nothing has connected for 48 hours. Usually the modem's port forward.
