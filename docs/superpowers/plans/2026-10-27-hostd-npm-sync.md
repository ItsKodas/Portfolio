# hostd NPM Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hostd's Apache host rail with a new `edge` service that writes Nginx Proxy Manager proxy and redirection hosts, serves holding pages, and receives NPM's access logs for analytics, then remove the Apache code.

**Architecture:** A fourth hostd process, `edge`, holds the NPM credentials and is the only thing that calls the NPM API. The agent keeps all validation and rendering, and talks to `edge` over a Unix socket shared only by the two of them (the `fetcher` pattern: `shared/fetch-protocol.ts`, `agent/fetch-client.ts`, `fetcher/server.ts`). `domains.ts` renders a `HostsSpec` instead of a vhost and calls `edge` instead of `ApacheRail`.

**Tech Stack:** Node 22, TypeScript run through `tsx`, `node:test` (`npm test` in `hostd/`), Docker Compose. No new dependencies: `fetch`, `node:net`, `node:http` and `node:dgram` cover the NPM client, the socket, the holding page server and the syslog receiver.

**Spec:** `docs/superpowers/specs/2026-10-27-hostd-npm-sync-design.md`

## Global Constraints

- No em dashes (U+2014) anywhere except code comments: not in copy, docs, commit messages or PR text (CLAUDE.md). Check with Python, not a bash `$'—'` grep.
- Match hostd's style: four-space indent, no semicolons, single quotes, comments that explain why, `refuse(...)` for refusals, `{ ok: true, ... } | { ok: false, problem }` results rather than throws across process boundaries.
- `shared/` never imports from `agent/`, `api/`, `fetcher/` or `edge/`.
- hostd never updates or deletes an NPM host unless it carries that environment's marker, except the adopt verb (Task 5).
- A deploy never calls `edge` or NPM.
- `hostd-api` never gets the edge socket or the NPM credentials.
- NPM fixed values: `forward_scheme: 'http'`, `hsts_enabled: false`, `hsts_subdomains: false`, `caching_enabled: false`, `access_list_id: 0`, `locations: []`, `block_exploits: true`, `allow_websocket_upgrade: true`; redirection hosts `forward_scheme: 'https'`, `forward_http_code: 301`, `preserve_path: true`.
- Defaults: `HOSTD_UPSTREAM_HOST=192.168.0.8`, `HOSTD_NPM_ADDRESS=192.168.0.5`, `HOSTD_NPM_URL=http://192.168.0.5:81/api`, `HOSTD_EDGE_HTTP_PORT=8790`, `HOSTD_EDGE_SYSLOG_PORT=5514`, `HOSTD_EDGE_SOCKET=/run/hostd-edge/edge.sock`, `HOSTD_ACCESS_LOG_DIR=/var/log/hostd`. (Ports are this plan's call; nothing on the VM listens on them as of 2026-10-27.)
- NPM call timeout 30 000 ms. NPM writes are serialised in `edge`.
- Marker line, exactly: `# hostd: <project>/<environment>. Managed by hostd; edits here are overwritten.`
- Brotli snippet, exactly as it is on the live hosts:
  ```nginx
  if ($http_content_encoding ~* "(^|,)\s*br\s*(,|$)") {
      return 415;
  }
  ```

## Review Focus

1. **A host Koda edited by hand after adopt** (marker still first, fields changed): health reports drift and the next domain action rewrites it; a host whose marker was deleted is refused, never overwritten. Test in Task 5 and Task 10.
2. **NPM answers 200 with `meta.nginx_online: false`**: treated as a failure and the previous state written back in the same call, so the site comes back. Test in Task 5.
3. **NPM token expiry or NPM restart mid-session**: a 401 triggers one fresh login and one retry, never a loop. Test in Task 4.
4. **Hostname case and trailing dots, and zone suffix edges** (`spotondrones.com` vs `spotondrones.com.au`, a name two labels deep): certificate lookup works on `normaliseHostname` output, matches on label boundaries, refuses depth > 1. Test in Task 3.
5. **Syslog datagrams from anywhere but NPM, or for a host no registry entry knows**: dropped without writing anything. Test in Task 7.

---

### Task 1: Registry: NPM ids, certificates map, letsencrypt retired

**Files:**
- Modify: `hostd/src/shared/registry.ts` (`EnvironmentEntry`, `Registry`, `ENVIRONMENT_KEYS`, top-level keys, `CERTIFICATE_MODES`, the environment and top-level parsers)
- Modify: `hostd/src/shared/registry-write.ts` (new change kind)
- Modify: `hostd/registry/projects.example.yaml`
- Test: `hostd/src/shared/registry.test.ts`, `hostd/src/shared/registry-write.test.ts`

**Interfaces:**
- Produces: `export type NpmIds = { proxyHost: number, redirectionHost: number | null }` in `shared/registry.ts`; `EnvironmentEntry.npm: NpmIds | null`; `Registry.certificates: Map<string, number>`; `Change` gains `{ kind: 'set-npm', id: string, environment: EnvironmentName, npm: NpmIds | null }` (null removes the key).

- [ ] **Step 1: Write the failing tests** in `registry.test.ts`:
  - `parses an environment's npm ids`: `npm: { proxyHost: 10, redirectionHost: 4 }` gives `entry.npm` deep-equal to that; omitted gives `null`; `npm: { proxyHost: 10 }` gives `{ proxyHost: 10, redirectionHost: null }`.
  - `refuses npm ids that are not positive integers`: `proxyHost: 0`, `-1`, `'10'`, `1.5` each add a problem naming `npm.proxyHost`.
  - `parses the certificates map`: `certificates: { horizons.gg: 3, 1stcanzukbrigade.com: 16 }` gives `registry.certificates.get('horizons.gg') === 3`; a key that `normaliseHostname` rejects, or a value that is not a positive integer, is a registry failure naming the key.
  - `refuses certificate: letsencrypt`: the problem says `letsencrypt` is no longer supported and that `cloudflare-origin` is the only mode.
- [ ] **Step 2: Write the failing test** in `registry-write.test.ts`: `set-npm writes and clears the ids` (write `{ proxyHost: 10, redirectionHost: null }`, re-parse, get `npm.redirectionHost === null` and no `redirectionHost` key in the YAML; write `null`, the `npm` key is gone).
- [ ] **Step 3: Run** `cd hostd && node --import tsx --test src/shared/registry.test.ts src/shared/registry-write.test.ts`. Expected: the new tests fail.
- [ ] **Step 4: Implement** in `registry.ts` and `registry-write.ts`. `CERTIFICATE_MODES` becomes `['cloudflare-origin'] as const`. `certificates` defaults to an empty map. Write `redirectionHost` only when it is not null.
- [ ] **Step 5: Run** the same command plus `npm test`. Expected: all pass (fix any fixture that used `letsencrypt`).
- [ ] **Step 6: Add** `certificates:` and one `npm:` example to `projects.example.yaml`.
- [ ] **Step 7: Commit** `git commit -m "Give the registry NPM host ids and a certificate per zone"`

### Task 2: The edge protocol

**Files:**
- Create: `hostd/src/shared/edge-protocol.ts`
- Create: `hostd/src/shared/holding.ts` (move `holdingPagePath` and `maintenanceKey` here from `agent/holding-pages.ts`, which re-exports them)
- Test: `hostd/src/shared/edge-protocol.test.ts`

**Interfaces:**
- Consumes: `NpmIds`, `EnvironmentName` from `shared/registry.ts`.
- Produces:
  ```ts
  export type Owner = { project: string, environment: EnvironmentName }
  export type ProxyHostSpec = {
      domain_names: string[], forward_host: string, forward_port: number, certificate_id: number,
      ssl_forced: boolean, http2_support: boolean, advanced_config: string,
  }
  export type RedirectionHostSpec = {
      domain_names: string[], forward_domain_name: string, certificate_id: number,
      ssl_forced: boolean, http2_support: boolean, advanced_config: string,
  }
  export type HostsSpec = { proxy: ProxyHostSpec, redirection: RedirectionHostSpec | null }
  export type FoundHost = {
      kind: 'proxy' | 'redirection' | 'dead', id: number, domain_names: string[], owner: Owner | null,
      forward_host: string | null, forward_port: number | null, hasLocations: boolean, spec: ProxyHostSpec | RedirectionHostSpec | null,
  }
  export type EdgeRequest =
      | { verb: 'health' }
      | { verb: 'certificates' }
      | { verb: 'find', domains: string[] }
      | { verb: 'get', owner: Owner, ids: NpmIds }
      | { verb: 'apply', owner: Owner, ids: NpmIds | null, spec: HostsSpec, adopt: boolean }
      | { verb: 'remove', owner: Owner, ids: NpmIds }
  export type EdgeReply =
      | { ok: true, verb: 'health', npmAge: number | null }
      | { ok: true, verb: 'certificates', ids: number[] }
      | { ok: true, verb: 'find', hosts: FoundHost[] }
      | { ok: true, verb: 'get', current: HostsSpec | null }
      | { ok: true, verb: 'apply', ids: NpmIds, previous: HostsSpec | null }
      | { ok: true, verb: 'remove' }
      | { ok: false, problem: string, output?: string }
  export function markerFor(owner: Owner): string
  export function ownerOf(advancedConfig: string): Owner | null
  export function parseEdgeRequest(value: unknown): EdgeRequest | null
  export function parseEdgeReply(value: unknown): EdgeReply | null
  ```

- [ ] **Step 1: Write the failing tests**: `markerFor({ project: 'spotondrones', environment: 'live' })` equals `'# hostd: spotondrones/live. Managed by hostd; edits here are overwritten.'`; `ownerOf` reads it back only from the **first line** (a marker on line 2 gives `null`, an id that `registry.ts`'s id rule rejects gives `null`); `parseEdgeRequest` round-trips each verb and returns `null` for unknown verbs, missing fields, non-integer ports and a `spec.proxy.domain_names` that is not a string array; `parseEdgeReply` likewise.
- [ ] **Step 2: Run** `node --import tsx --test src/shared/edge-protocol.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `edge-protocol.ts` and `holding.ts` in the style of `fetch-protocol.ts`.
- [ ] **Step 4: Run** it plus `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Define the protocol between the agent and edge"`

### Task 3: Rendering an environment to NPM hosts

**Files:**
- Create: `hostd/src/agent/npm-render.ts`
- Test: `hostd/src/agent/npm-render.test.ts`, `hostd/src/agent/npm-render.nginx.test.ts`

**Interfaces:**
- Consumes: Task 2's types and `markerFor`; `normaliseHostname` from `shared/hostnames.ts`.
- Produces:
  ```ts
  export type HostsInput = {
      id: string, environment: EnvironmentName, primary: string, aliases: string[], port: number,
      flexibleSsl: boolean, token: string, certificateId: number | null,
      upstreamHost: string, edgeHost: string, edgeHttpPort: number,
  }
  export function renderHosts(input: HostsInput): HostsSpec
  export function certificateFor(certificates: Map<string, number>, hostnames: string[]):
      { ok: true, id: number } | { ok: false, problem: string }
  export function tokenFromHosts(spec: HostsSpec): string | null
  export function describeHosts(spec: HostsSpec): string   // human-readable, for the adopt preview
  ```

- [ ] **Step 1: Write the failing tests** in `npm-render.test.ts`:
  - `renders a Full SSL site`: `certificateId: 16`, `flexibleSsl: false`: `proxy.certificate_id === 16`, `ssl_forced === true`, `http2_support === true`, `forward_host === '192.168.0.8'`, `forward_port === 3000`, `domain_names` deep-equal `['1stcanzukbrigade.com']`.
  - `renders a Flexible site`: `certificate_id === 0`, `ssl_forced === false`, `http2_support === false`.
  - `advanced_config starts with the marker and carries the brotli snippet, the token location, the holding page and the syslog log`: first line equals `markerFor(...)`; contains `location = /.well-known/hostd/<token> {`, `add_header X-Hostd-Token "<token>" always;`, `return 204;`, `error_page 502 504 = @hostd_holding;`, `rewrite ^ /holding/spotondrones-live break;`, `proxy_pass http://192.168.0.8:8790;` (no URI part), `access_log syslog:server=192.168.0.8:5514,tag=hostd,nohostname hostd;`, and the brotli snippet verbatim.
  - `aliases go to a redirection host`: `aliases: ['spotondrones.com']`: `redirection.domain_names` deep-equal `['spotondrones.com']`, `forward_domain_name === 'www.spotondrones.com'`, same certificate and SSL flags as the proxy, `advanced_config` has the marker and the token location and no `error_page` or `access_log`. No aliases gives `redirection === null`.
  - `certificateFor matches on a label boundary`: map `{ spotondrones.com: 18, horizons.gg: 3 }`: `['redesign.spotondrones.com']` gives 18; `['spotondrones.com.au']` is a problem naming `spotondrones.com.au`; `['mappies.horizons.gg']` gives 3; `['uat1.mappies.horizons.gg']` is a problem saying it is two labels below `horizons.gg`; mixed zones (`['a.horizons.gg', 'spotondrones.com']`) is a problem; the longest key wins when two match.
  - `tokenFromHosts reads the token back`, and returns `null` when the location is missing.
- [ ] **Step 2: Write** `npm-render.nginx.test.ts`, skipped unless `process.env.HOSTD_NGINX_CHECK === '1'`: it writes an `nginx.conf` with `log_format hostd` (from Task 8's constant), one `server { listen 80; server_name x; <proxy advanced_config> location / { proxy_pass http://127.0.0.1:1; } }`, the same for the redirection host with `location / { return 301 https://x$request_uri; }`, and runs `docker run --rm -v <dir>:/etc/nginx:ro nginx:1.27-alpine nginx -t`, asserting exit 0.
- [ ] **Step 3: Run** `node --import tsx --test src/agent/npm-render.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 4: Implement** `npm-render.ts`. Zone depth: after the longest matching key `zone`, the hostname must be `zone` or have exactly one more label.
- [ ] **Step 5: Run** the unit test, then (after Task 8) `HOSTD_NGINX_CHECK=1 node --import tsx --test src/agent/npm-render.nginx.test.ts` on a machine with Docker. Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "Render an environment as NPM proxy and redirection hosts"`

### Task 4: The NPM API client

**Files:**
- Create: `hostd/src/edge/npm-client.ts`
- Test: `hostd/src/edge/npm-client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NpmHostKind = 'proxy-hosts' | 'redirection-hosts' | 'dead-hosts'
  export type NpmRecord = Record<string, unknown> & { id: number, domain_names: string[], advanced_config: string, meta?: Record<string, unknown> }
  export class NpmClient {
      constructor(options: { url: string, identity: string, secret: string, fetch?: typeof fetch, now?: () => number, timeoutMs?: number })
      list(kind: NpmHostKind): Promise<NpmRecord[]>
      get(kind: NpmHostKind, id: number): Promise<NpmRecord | null>   // null on 404
      create(kind: NpmHostKind, body: Record<string, unknown>): Promise<NpmRecord>
      update(kind: NpmHostKind, id: number, body: Record<string, unknown>): Promise<NpmRecord>
      remove(kind: NpmHostKind, id: number): Promise<void>
      certificateIds(): Promise<number[]>    // live (is_deleted false) certificate ids
      ageOfLastSuccess(): number | null
  }
  export class NpmError extends Error { status: number | null, body: string }
  ```

- [ ] **Step 1: Write the failing tests** with a fake `fetch`:
  - `logs in once and reuses the token`: the first call `POST <url>/tokens` with `{ identity, secret }`; two later `list` calls send `Authorization: Bearer <token>` and no second login.
  - `refreshes before expiry`: with `expires` 1 hour ahead and `now` moved to 5 minutes before it, the next call first does `GET <url>/tokens` and uses the new token.
  - `logs in again once on a 401, then gives up`: one 401 leads to one fresh login and one retry; a second 401 throws `NpmError` with `status: 401`.
  - `create/update/remove hit the right paths`: `POST /nginx/proxy-hosts`, `PUT /nginx/redirection-hosts/4`, `DELETE /nginx/dead-hosts/2`.
  - `get answers null on 404`.
  - `times out after timeoutMs` with an `NpmError` whose message names the path.
  - `certificateIds skips deleted certificates`.
- [ ] **Step 2: Run** `node --import tsx --test src/edge/npm-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `AbortSignal.timeout(timeoutMs)`. Refresh when fewer than 10 minutes remain.
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add edge's Nginx Proxy Manager client"`

### Task 5: Apply, remove, get and find, with the ownership guard

**Files:**
- Create: `hostd/src/edge/hosts.ts`
- Test: `hostd/src/edge/hosts.test.ts`

**Interfaces:**
- Consumes: `NpmClient` (Task 4); Task 2's types, `markerFor`, `ownerOf`.
- Produces:
  ```ts
  export type HostsDeps = { npm: Pick<NpmClient, 'list' | 'get' | 'create' | 'update' | 'remove' | 'certificateIds'>, upstreamHost: string }
  export function applyHosts(deps: HostsDeps, owner: Owner, ids: NpmIds | null, spec: HostsSpec, adopt: boolean): Promise<EdgeReply>
  export function removeHosts(deps: HostsDeps, owner: Owner, ids: NpmIds): Promise<EdgeReply>
  export function getHosts(deps: HostsDeps, owner: Owner, ids: NpmIds): Promise<EdgeReply>
  export function findHosts(deps: HostsDeps, domains: string[]): Promise<EdgeReply>
  ```
- Behaviour pinned by the spec and this plan:
  - Body sent to NPM = the spec fields plus the Global Constraints' fixed values; `meta: {}`.
  - **Create** (`ids === null`): `findHosts` over every domain first; any match refuses with `<domain> is already on NPM proxy host <id>`. Then create the proxy, then the redirection host.
  - **Update** (`ids` given): read the current proxy host. Refuse unless `ownerOf(current.advanced_config)` equals `owner`, **or** `adopt` is true and the current host's `domain_names` include `spec.proxy.domain_names[0]` and its `forward_host`/`forward_port` equal the spec's. Same check on the redirection host when there is an id. Order: update the proxy (which drops the aliases from it), then create, update or delete the redirection host.
  - After every write, if the returned record's `meta.nginx_online === false`: write the object's previous state back (or delete it if it was just created), and answer `{ ok: false, problem: 'NPM refused the configuration for <project> <environment>', output: meta.nginx_err }`. This revert lives here, not in the agent, because only edge has the previous state in hand; it returns it as `previous` so the agent can keep it for an adoption undo. (Plan decision; the spec put the revert in the agent.)
  - `previous` in the reply is the pre-call `HostsSpec`, or `null` on a create.
  - `remove` deletes the redirection host first, then the proxy host, each only if owned.
  - `certificate_id` other than 0 must be in `certificateIds()`, else refuse naming the id.
- [ ] **Step 1: Write the failing tests** against an in-memory fake `npm`:
  - `creates a proxy and a redirection host and answers their ids`.
  - `refuses a create when a domain is already on another host`.
  - `refuses to update a host without this owner's marker`: also when the marker names another environment, and when the marker is on line 2.
  - `adopt may claim an unmarked host whose domains and upstream match`, and `adopt refuses one whose upstream differs` (port 5007 vs 5008).
  - `moves aliases from the proxy host to a new redirection host in that order`: the fake records the call order `update proxy` then `create redirection`.
  - `puts the previous state back when NPM reports nginx_online false`: the fake answers `meta: { nginx_online: false, nginx_err: 'bad' }` to an update; the reply is `ok: false` with `output: 'bad'`, and the fake's final state equals the starting state.
  - `refuses an unknown certificate id`.
  - `remove refuses an unowned host and deletes nothing`.
- [ ] **Step 2: Run** `node --import tsx --test src/edge/hosts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `hosts.ts`.
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Let edge apply hosts only to environments it owns"`

### Task 6: The edge process, its socket, and the agent's client

**Files:**
- Create: `hostd/src/edge/server.ts`, `hostd/src/edge/index.ts`, `hostd/src/agent/edge-client.ts`
- Test: `hostd/src/edge/server.test.ts`, `hostd/src/agent/edge-client.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5.
- Produces: `export function handleEdge(request: EdgeRequest, deps: HostsDeps & { npmAge(): number | null }): Promise<EdgeReply>` in `server.ts` (one request line, one reply line, writes serialised through one promise queue as `ApacheRail.send` did); `export type EdgeClient = { call(request: EdgeRequest): Promise<EdgeReply> }`, `export class EdgeUnavailableError extends Error`, `export const EDGE_TIMEOUT_MS = 150_000` and `export function edgeClient(connect: Connect): EdgeClient` in `edge-client.ts` (copy `fetch-client.ts`'s shape; the timeout leaves room for a create plus a redirection host plus a revert).
- `edge/index.ts` reads the env vars in Global Constraints plus `HOSTD_NPM_IDENTITY`, `HOSTD_NPM_SECRET` (required; exit with a clear message if missing), `HOSTD_SOCKET_GID`, `HOSTD_STATUS_FILE`, and starts the socket server (Task 6), the holding page server and the syslog receiver (Task 7). Socket mode 0660, group `HOSTD_SOCKET_GID`, as the fetcher's.
- [ ] **Step 1: Write the failing tests**: `server.test.ts`: `answers each verb through its handler` with stubbed hosts functions; `refuses an unparseable line with ok false`; `serialises apply calls` (the second apply starts only after the first resolves). `edge-client.test.ts`: the same cases `fetch-client.test.ts` covers (reply parsed, unreadable reply and socket error raise `EdgeUnavailableError`, timeout).
- [ ] **Step 2: Run** both. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** both plus `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Run edge as its own process behind a socket only the agent shares"`

### Task 7: Holding pages over HTTP and the syslog receiver

**Files:**
- Create: `hostd/src/edge/holding-http.ts`, `hostd/src/edge/syslog.ts`
- Test: `hostd/src/edge/holding-http.test.ts`, `hostd/src/edge/syslog.test.ts`

**Interfaces:**
- Consumes: `holdingPagePath` from `shared/holding.ts`; `accessLogPath` (move `accessLogName`/`accessLogPath` into `shared/analytics.ts`, re-exported from `agent/analytics.ts`); the registry loader edge uses (`registry-store.ts`).
- Produces: `export function holdingHandler(root: string, readFile: (path: string) => Promise<string | null>): (req, res) => void`; `export function syslogLine(datagram: string, source: string, allowed: string, route: (host: string) => { id: string, environment: EnvironmentName } | null): { path: string, line: string } | null` (pure) and `export function startSyslog(options: { host: string, port: number, allowed: string, logDir: string, route: ..., append: (path: string, line: string) => Promise<void> }): Socket`.
- [ ] **Step 1: Write the failing tests**:
  - `holding-http.test.ts`: `GET /holding/spotondrones-live` answers 503, `Retry-After: 120`, `Content-Type: text/html; charset=utf-8`, the file's body; `/holding/../etc/passwd`, `/holding/Bad-Live`, `/holding/x-nosuchenv` and `/` answer 404 without reading a file; a missing page answers 503 with a short built-in fallback page.
  - `syslog.test.ts`: `<190>Oct 27 16:01:51 hostd: www.spotondrones.com\t1730000000.123\t...` from `192.168.0.5` with a route for that host gives `{ path: '/var/log/hostd/hostd-spotondrones-live.access.log', line: '1730000000.123\t...' }` (the host field removed); the same datagram from `192.168.0.9` gives `null`; an unknown host gives `null`; a datagram with no `hostd: ` tag gives `null`; host matching is case-insensitive.
- [ ] **Step 2: Run** both. Expected: FAIL.
- [ ] **Step 3: Implement**. The route map is rebuilt from the registry each time the registry file changes (or once a minute), mapping every `hostnamesOf(environment)` to its owner.
- [ ] **Step 4: Run** both. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Serve holding pages and collect NPM access logs in edge"`

### Task 8: Analytics from nginx's log format

**Files:**
- Modify: `hostd/src/agent/analytics.ts` (`parseLine`, new constant, `HOSTD_ACCESS_LOG_DIR` default)
- Test: `hostd/src/agent/analytics.test.ts`

**Interfaces:**
- Produces: `export const NGINX_LOG_FORMAT: string`, exactly:
  ```
  log_format hostd escape=default '$host\t$msec\t$remote_addr\t$http_cf_connecting_ip\t$http_x_forwarded_for\t$request_method\t$uri\t$status\t$http_referer\t$http_user_agent\t$http_accept\t$http_rsc\t$http_next_router_prefetch\t$http_sec_purpose\t$http_purpose\t$http_cf_ipcountry';
  ```
  The fields after `$host` are `FIELDS`' fifteen in the same order, so a written line has the shape `parseLine` already reads.
- [ ] **Step 1: Write the failing tests**: `reads nginx's fractional epoch time` (`1730000000.789` gives `time === 1730000000000`); `reads an nginx line end to end` (a real-shaped line with `-` for absent headers and `\x22` in the user agent counts as one page view with the right path, referrer and country); `NGINX_LOG_FORMAT lists sixteen fields, host first, then FIELDS' order` (split on `\t`, map each nginx variable to its Apache field in a table in the test).
- [ ] **Step 2: Run** `node --import tsx --test src/agent/analytics.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**: `parseLine` floors a fractional time. Keep `ACCESS_LOG_FORMAT` until Task 13 removes Apache.
- [ ] **Step 4: Run** again plus `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Count visits from nginx's access log format"`

### Task 9: domains.ts on edge

**Files:**
- Modify: `hostd/src/agent/domains.ts` (rewrite), `hostd/src/agent/agent.ts` (domain verb wiring, `rewriteMovedVhost`, `removeVhosts`, the delete and restore vhost ops), `hostd/src/agent/port-change.ts` (rename `rewriteVhost` to `rewriteHosts`), `hostd/src/agent/index.ts` (wiring)
- Create: `hostd/src/agent/adopted-store.ts`
- Test: `hostd/src/agent/domains.test.ts` (rewrite), `hostd/src/agent/adopted-store.test.ts`, `hostd/src/agent/agent.test.ts` (fixtures that used the fake rail), `hostd/src/agent/port-change.test.ts`
- Create: `hostd/src/agent/testing/fake-edge.ts` (in-memory `EdgeClient` backed by Task 5's `hosts.ts` over a fake NPM)

**Interfaces:**
- Consumes: `EdgeClient` (Task 6), `renderHosts`, `certificateFor`, `tokenFromHosts`, `describeHosts` (Task 3), `set-npm` (Task 1).
- Produces:
  ```ts
  export type DomainsConfig = { upstreamHost: string, edgeHost: string, edgeHttpPort: number }
  export type DomainsDeps = {
      edge: EdgeClient
      adopted: AdoptedStore
      writeRegistry(change: Change): Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
      reloadRegistry(): Promise<Registry>
      refreshHoldingPage?(project: ProjectEntry, environment: EnvironmentEntry): Promise<void>
      config: DomainsConfig
  }
  export function writeHosts(deps, project, environment, token): Promise<DomainsWritten | Refusal>
  export function removeHosts(deps, project, environment): Promise<DomainsWritten | Refusal>
  export function setAliases(deps, project, environment, aliases, token): Promise<DomainsWritten | Refusal>
  export function previewAdopt(deps, project, environment, token): Promise<AdoptPreview | Refusal>
  export function adopt(deps, project, environment, token, disable: string[]): Promise<DomainsWritten | Refusal>
  export function restoreAdopted(deps, project, environment, restore: string[]): Promise<DomainsWritten | Refusal>
  export function currentToken(deps, environment): Promise<string | null>   // via edge get + tokenFromHosts
  // adopted-store.ts, files under /var/lib/hostd/adopted/<id>-<environment>.json
  export type AdoptedStore = { save(owner: Owner, record: { ids: NpmIds, previous: HostsSpec }): Promise<void>, read(owner: Owner): Promise<{ ids: NpmIds, previous: HostsSpec } | null>, clear(owner: Owner): Promise<void> }
  ```
- Behaviour:
  - `writeHosts` refuses with `certificateFor`'s problem when the environment is not Flexible and has no zone; calls `edge apply` with `ids: environment.npm`, `adopt: false`; on a create, writes `set-npm` with the returned ids. `written.path` is `npm:proxy-host/<id>`.
  - `removeHosts` calls `edge remove` then `set-npm null`; an environment with `npm === null` is a no-op success.
  - `setAliases` keeps its registry-first order, and its claim check becomes `edge find` on the added aliases (any host not owned by this environment refuses, naming the host).
  - `previewAdopt` maps NPM to the existing `AdoptPreview` shape so the portal keeps working: `proposed` = `describeHosts(rendered)`; one `claims` entry per found host with `path` = `NPM proxy host <id>` (or `redirection`/`dead`), `text` = `describeHosts`-style summary of the current host, `names`, and `unsupported` reasons: more than one host claims the names; a redirection or dead host claims them; upstream is not `upstreamHost:port`; `hasLocations`; the host carries another environment's marker. `extraNames` = names on the found proxy host the registry does not list, and any extra name also adds an `unsupported` reason ("<names> are on the NPM host but not in the registry; add them as aliases first"). `unreadable` = `[]`. `flexibleSsl` = the environment's own flag (no automatic switch). `adoptable` = exactly one proxy claim with no reasons. No claim at all refuses `bad-request`: `no NPM proxy host serves <primary>`.
  - `adopt` re-runs the preview, refuses unless adoptable, applies with `ids: { proxyHost: <found id>, redirectionHost: null }`, `adopt: true`, saves `{ ids, previous }` in the adopted store, then writes `set-npm`. `disable` is accepted and ignored.
  - `restoreAdopted` reads the adopted store and sends one `edge apply` with `ids` = the environment's current `npm` ids, `adopt: false`, and `spec = { proxy: saved.previous.proxy, redirection: null }`. The guard passes because it checks the hosts as they are now (marked by the adopt); the proxy host goes back to Koda's hand-made fields (no marker, so hostd no longer owns it) and the redirection host is deleted because the spec has none. Then `set-npm null` and `adopted.clear`. No saved record refuses `bad-request`. `restore` is accepted and ignored.
  - `agent.ts`'s `rewriteMovedVhost` and port change get the token from `currentToken` instead of reading a vhost file.
- [ ] **Step 1: Write the failing tests** in `domains.test.ts` using `fake-edge.ts`: one test per behaviour bullet above, including `refuses Full SSL without a zone certificate`, `a create records the npm ids in the registry`, `adopt keeps the proxy host id and records the redirection host`, `restore puts back the hand-made host and clears the ids`, `preview refuses a host on another upstream`, `preview reports names the registry does not list as unsupported`. `adopted-store.test.ts`: save, read, clear round-trip; a corrupt file reads as `null`.
- [ ] **Step 2: Run** `node --import tsx --test src/agent/domains.test.ts src/agent/adopted-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `adopted-store.ts`, `fake-edge.ts`, the new `domains.ts`, and update `agent.ts`, `port-change.ts`, `index.ts` (build `edgeClient(socketConnect(HOSTD_EDGE_SOCKET))`; drop `ApacheRail` construction).
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Write domains to NPM through edge instead of Apache"`

### Task 10: Health, drift and the maintenance flag

**Files:**
- Modify: `hostd/src/agent/agent.ts` (health), `hostd/src/agent/index.ts` (`setMaintenance`, `clearMaintenance`, `railAge`), `hostd/src/shared/protocol.ts` (comment on `railAge`), `hostd/src/api/index.ts` (`verifyTarget`)
- Create: `hostd/src/agent/drift.ts`
- Test: `hostd/src/agent/drift.test.ts`, `hostd/src/agent/agent.test.ts`, `hostd/src/api/routes.test.ts` or the existing `verifyTarget` test

**Interfaces:**
- Produces: `export function driftWarnings(registry: Registry, edge: EdgeClient, config: DomainsConfig): Promise<string[]>`.
- `railAge` keeps its name and wire shape and now means "ms since edge last had a successful NPM call", from the `health` verb (`npmAge`). `RAIL_STALE_MS` and the portal stay as they are.
- [ ] **Step 1: Write the failing tests** in `drift.test.ts`: `reports an owned host whose fields differ from the render` (warning names project, environment, host id and the fields, e.g. `block_exploits`); `reports an NPM host not owned by hostd that serves a registry hostname`; `reports nothing when everything matches`; `reports edge being unreachable as one warning, not a throw`. In `agent.test.ts`: `health answers railAge from edge's npmAge` and `health includes drift warnings`. For `verifyTarget`: every record is `{ scheme: 'https', proxied: true }`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**. Health computes drift on request with a 60 s cache so the portal polling health does not hammer NPM. `setMaintenance` keeps `holdingPages.refreshKey(key, 'upgrading')` and stops writing a flag; `clearMaintenance` resolves immediately. `verifyTarget` collapses to the https case (delete the letsencrypt comment).
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Report NPM drift in health and drop the maintenance flag"`

### Task 11: Compose, Dockerfile and env files

**Files:**
- Modify: `hostd/Dockerfile` (an `edge` target: `FROM base AS edge`, `CMD ["node", "--import", "tsx", "src/edge/index.ts"]`), `hostd/docker-compose.yml`
- Create: `hostd/example.env.edge`
- Modify: `hostd/.gitignore` if it lists `.env.fetcher` (add `.env.edge`)

- [ ] **Step 1: Edit `docker-compose.yml`**:
  - New service `edge`: `build: { context: ., target: edge }`, `container_name: hostd-edge`, `init: true`, `network_mode: host` (so the syslog source address is NPM's real address and the holding page port binds `192.168.0.8` directly, with no Docker NAT in between; it binds only `HOSTD_UPSTREAM_HOST`), `env_file: .env.edge`, the Global Constraints env vars, volumes: `hostd-edge-sock:/run/hostd-edge`, `./registry:/etc/hostd/registry:ro`, `/var/www/hostd-maintenance:/var/www/hostd-maintenance:ro`, `/var/log/hostd:/var/log/hostd`, the same healthcheck block as the others, `restart: unless-stopped`.
  - `agent`: add `hostd-edge-sock:/run/hostd-edge`, `HOSTD_EDGE_SOCKET`, `HOSTD_UPSTREAM_HOST`, `HOSTD_EDGE_HTTP_PORT`, `/var/log/hostd:/var/log/hostd:ro` and `HOSTD_ACCESS_LOG_DIR: /var/log/hostd`; add `depends_on: [edge]`.
  - Add the `hostd-edge-sock` volume. Do not remove the Apache mounts yet (Task 12).
- [ ] **Step 2: Write `example.env.edge`** with `HOSTD_NPM_IDENTITY=hostd@horizons.gg` and `HOSTD_NPM_SECRET=` (empty), with a comment that it is the NPM user from RUNBOOK.
- [ ] **Step 3: Run** `docker compose -f hostd/docker-compose.yml config --quiet` (with empty `.env*` files created for the check and removed after). Expected: exit 0.
- [ ] **Step 4: Run** `docker build --target edge hostd`. Expected: success (this also runs `npm test`).
- [ ] **Step 5: Commit** `git commit -m "Add the edge service to hostd's compose file"`

### Task 12: Remove Apache

**Files:**
- Delete: `hostd/src/agent/apache-rail.ts`, `apache-rail.test.ts`, `apache-rail-fake.test.ts`, `hostd/src/shared/apache.ts`, `apache.test.ts`, `hostd/src/agent/vhost.ts`, `vhost.test.ts`, `hostd/src/agent/sites-enabled.ts`, `sites-enabled.test.ts`, `hostd/src/agent/testing/fake-rail.ts`, `hostd/host/hostd-apache.sh`, `hostd-apache.path`, `hostd-apache.service`, `apache-include.conf`
- Modify: `hostd/src/agent/boot-checks.ts` (+ test: drop `siblingDirProblem` and the Origin cert gate), `hostd/src/agent/index.ts`, `hostd/src/agent/analytics.ts` (drop `ACCESS_LOG_FORMAT`), `hostd/docker-compose.yml` (drop `HOSTD_APACHE_*`, `HOSTD_ORIGIN_*`, `HOSTD_ACME_WEBROOT`, `HOSTD_MAINTENANCE_DIR`, and the `/etc/hostd/apache`, `/etc/apache2/*`, `/etc/ssl/hostd`, `/run/hostd/maintenance`, `/var/log/apache2` mounts and their comments), `hostd/src/api/adopt-check.ts` comments that mention vhost files
- Modify portal copy: every user-visible string under `app/(portal)/portal/sites/[id]/` and `app/(portal)/portal/newSite/` that says Apache, vhost, sites-enabled or "file" for a domain config (find with `rg -n "Apache|vhost|sites-enabled" app server`). NPM wording: "the NPM proxy host", "Nginx Proxy Manager". Tests that assert those strings change with them.

- [ ] **Step 1: Delete and edit** as listed.
- [ ] **Step 2: Run** `rg -n "ApacheRail|renderVhost|vhostPath|sites-enabled|HOSTD_APACHE|hostd-apache" hostd/src app server`. Expected: no matches outside comments that explain history (none should be needed).
- [ ] **Step 3: Run** `cd hostd && npm test`, then `npx tsc --noEmit -p hostd`, then from the repo root `npx vitest run app/(portal)/portal/sites app/(portal)/portal/newSite`. Expected: all pass.
- [ ] **Step 4: Scan** the diff for em dashes with Python (`git diff | python -I -c "import sys; print(sum('—' in l for l in sys.stdin.read().splitlines() if l.startswith('+')))"`). Expected: `0`.
- [ ] **Step 5: Commit** `git commit -m "Remove the Apache rail now that NPM serves the sites"`

### Task 13: RUNBOOK rollout

**Files:**
- Modify: `hostd/RUNBOOK.md` (replace the Apache host-half section; keep everything else)

- [ ] **Step 1: Write** the rollout section from the spec's "Rollout", with exact commands:
  1. NPM user: in the NPM UI, Users, add `hostd@horizons.gg`, not admin, permissions: visibility All, Proxy Hosts Manage, Redirection Hosts Manage, Certificates View, the rest Hidden. Put its password in `/opt/horizons/hostd/.env.edge`.
  2. Log format: `ssh proxmox`, `pct exec 101 -- sh -c 'mkdir -p /data/nginx/custom && cat >> /data/nginx/custom/http_top.conf'` with `NGINX_LOG_FORMAT`'s exact text, then `pct exec 101 -- nginx -t && pct exec 101 -- nginx -s reload`.
  3. Registry fixes: spotondrones live aliases add `spotondrones.net.au` and `www.spotondrones.net.au`; remove `flexibleSsl` from backroom live, geoguesser live, pmpc-group live, spotondrones redesign; add `certificates: { horizons.gg: 3, 1stcanzukbrigade.com: 16, thebackroom.dev: 17, spotondrones.com: 18 }`. Note: spotondrones live's `.com.au` and `.net.au` names are Flexible today (no certificate), which needs no map entry; if it moves to Full, each of those zones needs its own Origin certificate.
  4. `sudo mkdir -p /var/log/hostd` and the logrotate rule `/etc/logrotate.d/hostd`: `/var/log/hostd/*.log { daily rotate 14 compress delaycompress missingok notifempty copytruncate }`.
  5. Deploy hostd; check `docker logs hostd-edge` shows the login, the socket, the holding server on `192.168.0.8:8790` and syslog on `192.168.0.8:5514/udp`. From another LAN machine, `curl -i http://192.168.0.8:8790/holding/backroom-live` answers 503.
  6. Adopt each site from the portal in this order: pmpcold, mappies, pmpcgroup, arbysauto, 1stcanzuk, redesign, backroom, spotondrones live. After each: `curl -sI https://<primary>/` answers as before, `curl -sI https://<alias>/` answers 301 to the primary, the domain shows verified in the portal, and a visit appears in `/var/log/hostd/` within a minute.
  7. Once all are adopted: `sudo rm -rf /etc/apache2/hostd /etc/hostd/apache /run/hostd/maintenance` on the VM.
  8. Undo for one site: the portal's adopt undo puts the hand-made NPM host back.
- [ ] **Step 2: Scan** RUNBOOK for em dashes with Python. Expected: `0`.
- [ ] **Step 3: Commit** `git commit -m "Document the NPM rollout in the hostd runbook"`
