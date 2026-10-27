# hostd: sync domains to Nginx Proxy Manager

Date: 2026-10-27. Status: draft for Koda's review.

## Why

The sites moved off the old dedi. They now run on the **websites VM (192.168.0.8)**, Apache is gone,
and the front door is **Nginx Proxy Manager 2.16**, a native install in **Proxmox CT 101**
(API at `http://nginx.home.arpa/api`). Koda set every site up in NPM by hand and it all works.

hostd still speaks to Apache through the file rail (`apache-rail.ts`, `hostd-apache.sh`). Nothing
answers that rail on the new VM (`hostd-apache.path` is not installed), so every domain action in the
portal (add or remove a domain, aliases, Flexible SSL, websockets, adopt) times out after 30 seconds.
Analytics counts Apache access logs nobody writes any more, so its numbers have stopped.

The goal: the portal drives NPM through its API, so a domain change made in the portal shows up in NPM
with the right certificate, and Koda stops configuring sites in NPM by hand.

## Goals

1. Every domain action the portal has today works again, by writing NPM proxy hosts instead of Apache
   vhosts.
2. What works today keeps working. The first sync of each site reproduces its current NPM setup
   (forwarding, certificate, Force SSL, HTTP/2, Block Exploits, websockets, the brotli snippet), apart
   from the deliberate changes listed under "Changes to live behaviour".
3. Domain verification works again, so the portal can tell when a client's domain points at the site.
4. A holding page shows while a deploy swaps containers or a site is down, as it did under Apache.
5. Portal analytics work again, from NPM's traffic.
6. The Apache code, host files, mounts and settings are removed once nothing uses them.

## Non-goals

- Uploading Cloudflare Origin certificates or requesting Let's Encrypt certificates from hostd. Koda
  uploads a zone's Origin certificate in NPM once; hostd only picks the right one (see Certificates).
- Managing anything in NPM that is not a hostd site: `horizons.gg`/`www.horizons.gg` (the portal itself,
  proxy host 1), wg, nginx, dns, proxmox, pelican, artemis, access lists, streams, NPM settings.
- Changing DNS or Cloudflare settings.
- Putting the site ports behind a firewall rule (a possible later hardening; PR #181 publishes them on
  every interface so NPM can reach them).

## Anti-goals (a failure even if it technically works)

- hostd edits, disables or deletes a proxy host it does not own. One wrong write could take down the
  Proxmox UI, the DNS admin or WireGuard.
- A sync takes a working site offline: wrong upstream, wrong certificate, or Force SSL switched on for a
  Flexible SSL zone (the redirect loop that took thebackroom.dev down on 2026-09-22).
- A deploy makes an NPM API call while the site is down. The swap window must stay as short as it is
  now, and an NPM outage must not fail or slow a deploy.
- NPM credentials reach `hostd-api` (the process the portal talks to) or any client-facing surface.

## What exists in NPM today (read 2026-10-27, read-only, from `/data/database.sqlite`)

| NPM host | Domains | Upstream | Cert | Force SSL | Notes |
|---|---|---|---|---|---|
| 7 | spotondrones.com, .com.au, .net.au, plus www. of each | .8:5007 | none | off | Flexible |
| 8 | arbysauto.com, www. | .8:5001 | none | off | Flexible |
| 9 | thebackroom.dev, www. | .8:3002 | 17 Origin (Backroom) | on | |
| 10 | 1stcanzukbrigade.com, www. | .8:3000 | 16 Origin (Whitewolf) | on | |
| 11 | mappies.horizons.gg | .8:5003 | 3 Origin (horizons.gg) | on | no brotli snippet |
| 12 | pmpcgroup.horizons.gg | .8:5008 | 3 | on | Block Exploits off, no websockets |
| 13 | pmpcold.horizons.gg | .8:5005 | 3 | on | no websockets |
| 14 | redesign.spotondrones.com | .8:5002 | 18 Origin (SpotOnDrones) | on | no websockets |

Every host with a certificate has HTTP/2 on and HSTS off. Most carry this `advanced_config`:

```nginx
if ($http_content_encoding ~* "(^|,)\s*br\s*(,|$)") {
    return 415;
}
```

Aliases are served directly on the same proxy host; nothing redirects to the primary domain. There are
no redirection hosts. NPM has one user (`koda@horizons.gg`, admin).

## Changes to live behaviour (deliberate)

- **Registry corrections, made before adoption** (RUNBOOK step, by hand): spotondrones live gains the
  aliases `spotondrones.net.au` and `www.spotondrones.net.au`; `flexibleSsl` is removed from backroom
  live, geoguesser live, pmpc-group live and spotondrones redesign, because NPM serves them with an
  Origin certificate and Force SSL, and that works. Without this, adoption would switch them to Flexible.
- **Aliases redirect to the primary domain** (301, path and query kept), as hostd's Apache vhosts did,
  instead of serving the site at several addresses. *My call:* one canonical URL is better for cookies
  and search, and it is what hostd was built to do. Visitors notice nothing but the address bar.
- **Every hostd host gets the same template** (below), so small differences between hosts (Block
  Exploits off on 12, websockets off on 12 to 14, no brotli snippet on 11 to 14) go away.

## Design

### Shape

A fourth hostd service, **`edge`**, on the websites VM, alongside `agent`, `api` and `fetcher`:

- It holds the NPM credentials and is the only process that talks to the NPM API.
- It serves the holding pages over HTTP on the LAN.
- It receives NPM's access logs over syslog and writes them to files the agent reads.

The agent talks to `edge` over its own Unix socket, in a volume shared only by `agent` and `edge`, the
same pattern `fetcher` uses. `api` never sees that socket or the NPM credentials. The agent keeps
`network_mode: none`.

`edge` replaces the Apache rail end to end: where `domains.ts` called `rail.send(...)` with a rendered
vhost, it now asks `edge` to apply a rendered **proxy host spec**. The agent still owns all validation,
the registry and rendering; `edge` validates only that it was asked to touch a host it owns (below) and
does what it is told.

### Ownership: hostd only ever touches its own hosts

- Each environment that hostd manages records its NPM ids in the registry:
  `npm: { proxyHost: 10, redirectionHost: 4 }` on the environment entry (redirection host only when there
  are aliases).
- Every host hostd writes carries a first line in `advanced_config`:
  `# hostd: <project id>/<environment>. Managed by hostd; edits here are overwritten.`
- `edge` refuses to update or delete a host unless **both** match: the id is the one the agent names
  and that host's current `advanced_config` starts with the matching marker. A create is always
  allowed. The one exception is the explicit **adopt** verb, which may update an unmarked host, and
  only after `edge` itself re-reads it and confirms its `domain_names` include the environment's
  primary and its upstream is `HOSTD_UPSTREAM_HOST` and the environment's port. An adopt retried after
  a half-finished one (host already carries this environment's marker, registry has no id yet) is
  allowed too. *My call.* This is the guard against the anti-goal above, and it lives in `edge` because `edge` is the
  only place that can read the host's current state.
- Before a create, `edge` checks that none of the domain names is already on any NPM proxy, redirection
  or dead host (NPM refuses duplicates itself, but the error must be one the portal can show).

### What a hostd environment renders to

**Proxy host** (the primary domain only):

| Field | Value |
|---|---|
| `domain_names` | `[primary]` |
| `forward_scheme`, `forward_host`, `forward_port` | `http`, `HOSTD_UPSTREAM_HOST` (192.168.0.8), the environment's port |
| `certificate_id` | the zone's certificate (below), or 0 under Flexible SSL |
| `ssl_forced`, `http2_support` | true when there is a certificate, false under Flexible SSL |
| `hsts_enabled` | false |
| `block_exploits` | true |
| `allow_websocket_upgrade` | true for every site. *My call:* most live hosts have it on, and it costs nothing on a site that does not use it. The registry's `websockets` flag becomes unused and is left in place. |
| `caching_enabled` | false |
| `access_list_id` | 0 |
| `advanced_config` | marker line, brotli snippet, verification location, holding page, syslog access log (below) |

**Redirection host** (only when there are aliases): `domain_names` = the aliases, forward to the primary
with `https` (also under Flexible, where Cloudflare serves the https side, as the Apache aliases did), HTTP code 301, `preserve_path` true, same certificate and SSL
settings as the proxy host, `advanced_config` = marker line and the verification location.

**`advanced_config` parts**:

```nginx
# hostd: spotondrones/live. Managed by hostd; edits here are overwritten.

if ($http_content_encoding ~* "(^|,)\s*br\s*(,|$)") {
    return 415;
}

location = /.well-known/hostd/<token> {
    add_header X-Hostd-Token "<token>" always;
    return 204;
}

error_page 502 504 = @hostd_holding;
location @hostd_holding {
    rewrite ^ /holding/<project id>-<environment> break;
    proxy_pass http://192.168.0.8:<HOSTD_EDGE_HTTP_PORT>;
}

access_log syslog:server=192.168.0.8:<HOSTD_EDGE_SYSLOG_PORT>,tag=hostd,nohostname hostd;
```

- The verification location is an exact match, so it beats NPM's generated `location /` and, on a
  redirection host, beats the redirect. `verify.ts` and `verifier.ts` keep probing
  `/.well-known/hostd/<token>` for a 204 with the header, unchanged.
- The named location uses `rewrite ... break` and a bare `proxy_pass`, because nginx refuses a
  `proxy_pass` with a URI part inside a named location.
- `error_page` lists only 502 and 504, the errors nginx itself raises when the upstream is down or
  times out. It does not set `proxy_intercept_errors`, so a site's own 404 or 503 passes through
  untouched.
- The `hostd` log format is defined once at NPM's http level (below). NPM's own per-host log keeps
  working alongside it.
- The token and every other interpolated value are validated by the agent (token: `DOMAIN_TOKEN`'s hex
  class; hostnames: `normaliseHostname`; ids and environment names: the registry rules), so nothing
  needs escaping, as with `vhost.ts` today.

### Certificates

A new top-level registry map, **`certificates`**, names the NPM certificate for each zone:

```yaml
certificates:
  horizons.gg: 3
  1stcanzukbrigade.com: 16
  thebackroom.dev: 17
  spotondrones.com: 18
```

- A hostname's zone is found by longest suffix match against the map's keys, on a label boundary
  (`spotondrones.com` never matches `spotondrones.com.au`).
- A hostname may be the zone itself or exactly one label below it, which is what an Origin
  certificate (`zone` and `*.zone`) and Cloudflare's own edge certificate cover. A deeper name, such as
  a new environment's default `uat1.mappies.horizons.gg`, is refused with a message saying why, and the
  portal asks for a different address. *My call:* such a name would not work behind Cloudflare anyway.
- An environment that is not Flexible and whose primary or any alias has no matching zone is refused,
  with a message telling Koda to upload that zone's Origin certificate in NPM and add it to the map.
  Flexible environments need no entry.
- `edge` checks on each apply that the named certificate exists and is not deleted.
- The registry's per-environment `certificate` field: `cloudflare-origin` (geoguesser) becomes the
  only accepted value and means nothing new. `letsencrypt` (a name pointing straight at the server,
  not through Cloudflare) is refused from now on: no environment uses it, NPM would need a publicly
  trusted certificate hostd does not manage, and the verifier's plain-http path for it would meet NPM's
  Force SSL redirect. `verifyTarget()` in `api/index.ts` simplifies to the https path. *My call.*

### Maintenance and the holding page

The Apache design flipped a flag file on every deploy. That no longer works (NPM cannot see the
websites VM's disk), and making an API call on every deploy is an anti-goal. It is also not needed: the
swap stops the site's containers, so NPM gets a refused connection, raises 502, and `error_page` serves
the holding page.

- `holding-pages.ts` keeps writing each environment's page and refreshing it to "upgrading" before the
  swap, as now. `setMaintenance` keeps the refresh and stops writing a flag; `clearMaintenance` becomes
  a no-op. The `/run/hostd/maintenance` mount goes.
- `edge` serves `GET /holding/<project id>-<environment>` from the maintenance directory (read-only
  mount), with status 503 and `Retry-After: 120`, and nothing else on that port.
- *Trade-off accepted:* a deploy whose new container accepts connections but answers errors while
  starting shows those errors rather than the holding page. Apache had the same gap after the flag came
  down.

### Analytics

NPM's built-in log format lacks fields `analytics.ts` relies on (the `Accept` and `RSC` request headers,
Cloudflare's `CF-Connecting-IP`, the epoch time). So:

- hostd's log format is defined once in NPM's custom http include,
  `/data/nginx/custom/http_top.conf` on CT 101, by hand (RUNBOOK step; NPM's API cannot write it). It
  carries the same fields as `ACCESS_LOG_FORMAT`, tab separated, plus `$host` so `edge` can route the
  line. The exact field list is the builder's, as long as `parseLine` can rebuild what it reads today. nginx's
  `escape=default` replaces control characters with `\xXX`, so a tab is still only ever a separator.
- Every hostd proxy host also logs to syslog on the websites VM (the `access_log` line above).
- `edge` listens for syslog on UDP `<HOSTD_EDGE_SYSLOG_PORT>`, accepts datagrams only from
  `HOSTD_NPM_ADDRESS` (192.168.0.5), maps the logged `$host` to its environment through the registry,
  and appends the line to `<HOSTD_ACCESS_LOG_DIR>/<id>-<environment>.log`, the path
  `accessLogName()` already gives. Lines for hosts it does not know are dropped.
- The agent mounts that directory read-only and reads it as it read Apache's logs. Rotation: a
  logrotate rule on the VM (daily, fourteen kept, as Apache's was), installed by RUNBOOK, with
  `copytruncate` so `edge` keeps its file handles.
- UDP can drop lines under load. Analytics is a count, so this is accepted.
- The history already in `HOSTD_ANALYTICS_DIR` carries on; the gap since the move simply has no data.

### NPM API access

- A dedicated NPM user, `hostd@horizons.gg`, created by Koda (RUNBOOK). Not an admin. Permissions:
  visibility "all", proxy hosts "manage", redirection hosts "manage", certificates "view", everything
  else hidden. "All" visibility is needed to see and adopt the hosts Koda created.
- `edge` logs in with `POST /api/tokens` (identity and secret from `.env.edge`, not committed), keeps
  the token in memory, refreshes it with `GET /api/tokens` before it expires, and logs in again on a 401.
- Endpoints used: `GET/POST/PUT/DELETE /api/nginx/proxy-hosts[/:id]`, the same for
  `/api/nginx/redirection-hosts`, `GET /api/nginx/certificates`. Writes are serialised in `edge`, one at
  a time, as the Apache rail serialised them.
- NPM tests the nginx config after each write, but a failed test does **not** fail the API call
  (checked in CT 101's `/app/internal/nginx.js`): NPM renames that host's config to `.err`, reloads
  without it, and records `meta.nginx_online: false` and `meta.nginx_err`. So the host is offline, not
  left on its old config. `edge` treats `meta.nginx_online === false` in the response as the failure,
  and the agent immediately writes the previous spec back (the same revert `domains.ts` does today),
  which brings the host back. Because a bad render costs a short outage rather than nothing, the
  renderer's tests run `nginx -t` on rendered output in an nginx container (or an equivalent check),
  so a template mistake is caught in CI, not on a client's site.
- Timeouts: 30 seconds per call, as the rail had. `RAIL_STALE_MS` and the health figure carry over as
  "last successful NPM call".
- `HOSTD_NPM_URL` defaults to `http://192.168.0.5:81/api`. Builder to confirm which address `edge`
  reaches the API on from the VM; `nginx.home.arpa/api` answered from Koda's PC.

### Adoption

Every registry environment with a domain has an NPM host today (the eight in the table, `pmpcold`
included), so the rollout is adopt-only. A new environment, or a domain added later, goes through the
ordinary create path. Adopt with no matching host is refused rather than falling back to a create.

Adopt now means "take over the NPM hosts Koda made for this environment":

- **Preview**: find the proxy host whose `domain_names` include the environment's primary. Refuse when
  there is none, when there is more than one, when its upstream is not `HOSTD_UPSTREAM_HOST` and the
  environment's port, or when it has `locations` set. Show what the sync would change (a field-by-field
  diff, including any domains that would move to the redirection host and any domains on the NPM host
  that the registry does not list, which are refused rather than dropped).
- **Adopt**: write the rendered spec onto that same proxy host id (keeping the id means NPM's existing
  log files and stats carry on), create the redirection host for the aliases, and record both ids in
  the registry. The aliases are removed from the proxy host and added to the redirection host in that
  order, because NPM refuses a domain that is on two hosts.
- **Restore** (undo): put the proxy host back exactly as it was before the adopt (the agent keeps the
  pre-adopt spec in its state volume, as it kept the adopted vhost's backup), delete the redirection
  host, and clear the registry ids.
- The `sites-enabled.ts` checks that read hand-written Apache files (unsupported `RewriteRule`s and so
  on) have no NPM equivalent and go. The one that matters carries over: refusing a host whose upstream
  does not match.

### Health and drift

- The agent's `/health` reports whether `edge` and NPM answer, the age of the last good NPM call, and
  **drift**: any owned host whose current NPM state differs from what hostd would render (someone edited
  it in the NPM UI). Drift is reported, not fixed automatically; the next domain action on that
  environment rewrites it.
- The wildcard check in `sites-enabled.ts` (PR #131) becomes: warn about any NPM host not owned by hostd
  whose domain names match a registry hostname.

### Removal of Apache

In the same change, once the NPM path is tested: `apache-rail.ts`, `shared/apache.ts`, `vhost.ts`,
`sites-enabled.ts`, `boot-checks.ts`'s Origin cert gate, `host/hostd-apache.*`, `host/apache-include.conf`,
the Apache mounts and `HOSTD_APACHE_*`, `HOSTD_ORIGIN_*`, `HOSTD_ACME_WEBROOT` settings in
`docker-compose.yml`, and the Apache parts of `RUNBOOK.md`. Their tests go with them. Portal copy that
says "Apache" changes to name NPM or nothing.

## Rollout (RUNBOOK)

1. Koda creates the `hostd@horizons.gg` NPM user with the permissions above; its password goes in
   `.env.edge` on the VM.
2. Add `/data/nginx/custom/http_top.conf` with the `hostd` log format on CT 101; reload NPM.
3. Fix the registry by hand (aliases and `flexibleSsl`, above) and add the `certificates` map.
4. Deploy hostd with `edge`. Open the VM firewall (if any) for UDP syslog from 192.168.0.5 and the edge
   HTTP port from 192.168.0.5.
5. Adopt each site from the portal, one at a time, checking it in a browser after each, with
   thebackroom.dev last-but-one and spotondrones last (most aliases).
6. Remove the leftover Apache directories on the VM (`/etc/apache2/hostd`, `/etc/hostd/apache`).

## Left to the builder

- The exact `hostd` log format fields and the parser change, within the constraints above.
- Ports for `edge` (HTTP and syslog), the socket protocol between agent and `edge` (reusing the shared
  protocol style), and the NPM API client's shape.
- Whether `edge` is Node like the rest of hostd (expected) and how its tests fake NPM.
- How the portal's domain screens word NPM errors.
