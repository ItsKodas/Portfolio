# Mail stack runbook

## Before first start

1. Create a Cloudflare API token scoped to **Zone:DNS:Edit on `horizons.gg` only**. Nothing else.
2. Copy `mail/.env.example` to `mail/.env` and fill in `CF_API_TOKEN`, `CF_ZONE_ID`, `FORWARD_TO` and `DMARC_RUA`.
3. Do **not** forward port 25 on the modem yet.

## First start

```bash
cd mail && docker compose up -d && docker compose logs -f mailops
```

Expect `boot gate passed` within a minute. If it exits instead, the log names the failed check. The gate
fails on configuration problems only: a bad token, an unreachable outbound 25, or an undeterminable IP.

Then confirm the zone. `mail.dev.horizons.gg` A, `dev.horizons.gg` MX and TXT, and `_dmarc.dev.horizons.gg`
TXT should exist in Cloudflare, each commented `managed-by:mailops`, and the A record must be grey-clouded.
The DKIM record appears a cycle or two later, once docker-mailserver has generated the key.

## Open relay verification, before the port stays open

This is the step that protects you from the expensive mistake. Do it immediately, not later.

1. Forward port 25 to the host on the modem.
2. Run an external relay test at once, through MXToolbox's SMTP diagnostic or mail-tester.
3. Confirm it reports **no open relay**.

If the test reports an open relay, close port 25 on the modem before doing anything else, then investigate.
An open relay on a residential address is found within hours and the consequences outlive the mistake.

## Inbound end to end

Send a message from an external account to `contact@dev.horizons.gg`, then confirm:

- it arrives at `FORWARD_TO`
- the envelope sender was SRS-rewritten, visible as `SRS0=` in the received headers

## Measure deliverability, do not assume it

Send a message to the address mail-tester.com gives you and read the score. It reports reverse DNS, SPF,
DKIM, DMARC alignment and blocklist status together.

Reverse DNS is expected to score badly. The address is Telstra's `cpe-...` name, it does not
forward-confirm, and it cannot be changed on a residential plan. That is a known, accepted weakness.

If delivery to real recipients disappoints, switch to a relay: set `RELAY_HOST`, `RELAY_PORT`, `RELAY_USER`,
`RELAY_PASSWORD` and `RELAY_SPF_INCLUDE` in `mail/.env`, then `docker compose up -d`. SPF updates itself on
the next reconcile cycle. No rebuild, no redesign.

## Day to day

- Health: `docker compose ps` shows `mailops` healthy or unhealthy, and `/health/status.json` holds the detail.
- Warnings: `docker compose logs mailops | grep WARN`.
- A `dns-conflict` warning means something unmanaged sits at a name we want. Nothing is overwritten. Remove
  the conflicting record by hand, or rename ours.
- A `spamhaus` warning after an IP change means the new address arrived with inherited reputation damage.
  Switching to a relay is the remedy.
- An `inbound-stale` warning means nothing has connected for 48 hours. Usually the modem's port forward.
