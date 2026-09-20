# Portal to hostd client design

Date: 2026-09-20
Status: approved design, not yet implemented
Depends on: `2026-09-20-hostd-design.md` and `2026-09-20-hostd-provisioning-design.md` (both deployed),
and the portal's Part 2 client accounts (deployed)

## What this is

The portal has no way to talk to hostd. `server/` holds auth, clients, db, mailer and quotes, and nothing
that reaches the service controlling client sites. Every portal screen designed in
`2026-09-20-client-portal-screens-design.md` is blocked on this one module, so it is worth doing first and
worth keeping small.

This designs `server/hostd/`: the typed client, where the actor header comes from, what happens when hostd
is down, and the two changes hostd needs in order to serve the dashboard well.

It designs no screens. The screens are the mockups' business.

## What already lines up

Checked against the running code rather than assumed:

| Thing | State |
| --- | --- |
| hostd's API | `hostd-api` on port 8080, on a Docker network named `hostd`, no published port |
| Authentication | `Authorization: Bearer <HOSTD_API_TOKEN>`, compared in constant time |
| The actor | `X-Hostd-Actor: admin` or `client:<id>`, plus `X-Hostd-User` for the audit log |
| Client ids | hostd accepts `^[A-Za-z0-9_-]{1,64}$`; the portal mints `cl_` plus eight Crockford base32 characters, which fits without translation |
| User ids | hostd accepts `^[A-Za-z0-9_@.:+-]{1,128}$`, so an email address works as it stands |
| The join | `Site.projectId` already points at a key in hostd's registry, and the model already says hostd is the source of truth |

Nothing needs renaming on either side.

## Scope

### In scope

- `server/hostd/`: configuration, the HTTP client, actor derivation, the typed calls the screens need
- The route handler that relays hostd's log stream
- The compose change that puts `web` on the `hostd` network
- Two requests of hostd, recorded below so the session that owns it can pick them up

### Not in scope

- Any portal page or component. The screens are designed separately and owned elsewhere
- Deploys, backups, files and domains, none of which hostd implements yet
- Caching, until something is measurably slow

## Decisions

**hostd's settings are their own group.** `server/env.ts` already collects problems one group at a time, so a
missing relay setting stops email while the quote still saves. hostd gets the same treatment: with
`HOSTD_API_TOKEN` missing, the portal pages that need hostd say so and everything else, the landing page, the
quote form, the inbox, carries on. A portal that refuses to boot because a service it only partly depends on
is misconfigured is worse than one that degrades.

**The actor header is derived from the session and never accepted from a request.** This is the whole
security seam. hostd trusts the portal's word about who is asking, and its own design says plainly that a
compromised portal can act as any client. So nothing reaching the portal from a browser may influence that
header: an admin session becomes `admin`, a client session becomes `client:<clientId>` read from the Part 2
session cookie, and there is no third path. One function produces the header and every call goes through it.

**Ownership is checked on the portal side too.** hostd checks that the actor's client matches the project's,
and describes that check as a second line of defence against portal bugs. The reverse also holds: the portal
looks up its own `Site` row and confirms it belongs to the signed-in client before it calls at all. Two
checks, neither relying on the other, because the failure they guard against is a client reaching another
client's site.

**Failures are returned, not thrown.** Following `mail/mailops` and the quotes pipeline, a call returns a
result that either succeeded or explains why not. hostd being unreachable makes controls unavailable while
the rest of the page renders, which is what hostd's own design says should happen: client sites never depend
on hostd, and neither should the portal's ability to draw a page.

**A client never sees hostd's own error text.** Its messages can name paths, project ids and services. The
portal maps a refusal to something in the client's language and logs the original. An admin may see more,
because an admin is the operator.

**No caching in v1.** Status is read per request with `no-store`. Caching container state is how a portal
starts lying about whether a site is up, and the fix for slow is a measurement, not a guess.

## Architecture

### Modules

`server/hostd/`, following the shape of `server/clients/` and `server/quotes/`: side effects behind injected
adapters, failures collected, tests beside the code.

| Module | Purpose |
| --- | --- |
| `config.ts` | Reads `HOSTD_URL` and `HOSTD_API_TOKEN` as one group, collecting problems rather than throwing |
| `actor.ts` | Turns a session into `{ actor, user }`. The only place either header is produced |
| `client.ts` | The request function: base URL, bearer token, actor headers, timeout, typed result. `fetch` is injected |
| `projects.ts` | `list`, `get`, `start`, `stop`, `restart`, and the shapes the screens consume |
| `logs.ts` | Opens hostd's stream and exposes it for the route handler to relay |
| `errors.ts` | Maps a hostd refusal to a portal-facing message, per audience |

Each imports `server-only`, as the rest of `server/` does.

### Configuration

| Variable | Value |
| --- | --- |
| `HOSTD_URL` | `http://hostd-api:8080` |
| `HOSTD_API_TOKEN` | The same token as `hostd/.env` |

Added to `.env.example`. The token is the only secret the portal holds for hostd, and it grants the full verb
set on every registered project, so it is worth as much as an admin session.

### Deployment

The root `docker-compose.yml` has no `networks:` section at all today. It gains one:

```yaml
services:
  web:
    networks: [default, hostd]

networks:
  hostd:
    external: true
    name: hostd
```

hostd's own compose creates that network and names it `hostd`. Marking it external here means the portal
joins the existing one rather than creating a second, and that the portal never starts hostd or depends on
its lifecycle. Neither side publishes a port: the only route to hostd is from inside the network.

Deploying stays `git pull && docker compose up -d --build`, with hostd needing to be up first the very first
time so that the network exists.

### Logs

Server components cannot produce Server-Sent Events, so the log stream needs a route handler. The browser's
`EventSource` points at the portal, the handler derives the actor from the session, opens hostd's stream and
relays it. The browser never learns that hostd exists, never holds the token, and cannot name a project the
session does not own.

hostd closes a follow stream after an hour and expects a reconnect carrying `since=<last timestamp>`. The
relay passes that through rather than inventing its own retry.

## What the screens can build on today

hostd implements phase 1 and provisioning. Deploys, backups, files and domains are designed and unbuilt.

| Buildable now | Waiting |
| --- | --- |
| Site status, start, stop, restart | Deploy history, rollback, the commit list |
| Live and historical logs | Backups and their schedule |
| Env file listing and editing, operator only | File browsing and downloads |
| The audit log, which feeds the activity feed | Domains |

So roughly half of Koda's dashboard and half of a site's page can be built against what exists. That is worth
doing rather than waiting for the whole backend.

## Two requests of hostd

Recorded here because they belong to hostd, not the portal, and both are cheaper to do before the portal
works around them.

**1. Status in the project list.** The dashboard shows every site with its live status. `GET /projects`
returns the projects visible to the actor and `GET /projects/:id` returns status per service, so the
dashboard costs one request plus one per site, every render, each reaching the Docker API. Either
`GET /projects` should carry each project's status, or it should take a flag that makes it. This is the only
gap in the API the screens found.

**2. Memory, CPU and system disk in health.** hostd reports backup disk free, stale offsite copies, invalid
projects, failed Apache reloads and failed backups. The dashboard's server panel also shows memory, CPU and
the system disk, which nothing currently measures.

## Testing strategy

Unit tests with `fetch` faked, in the style of the quotes pipeline:

- the config group collects a missing URL and a missing token, and names them without printing the token
- an admin session produces `admin`, a client session produces `client:<id>`, and no other input reaches
  either header
- a client whose `Site` row belongs to another client is refused before any request is made
- a refusal from hostd becomes a client-facing message that contains no path, project id or service name,
  and the original reaches the log
- hostd unreachable, and hostd slow past the timeout, both return a result rather than throwing
- the log relay passes `since` through on a reconnect and never accepts a project from the query string

No test talks to a real hostd. The live check belongs in the runbook, against the throwaway project hostd's
own testing strategy already sets up.

## Known risks and accepted weaknesses

| Risk | Why it is accepted, or what limits it |
| --- | --- |
| The portal's token grants every verb on every registered project | Inherent: hostd authenticates the portal, not the person. hostd's design already records that a compromised portal can act as any client, and bounds what that reaches. The portal's own ownership check and the audit log are what narrow it. |
| A portal bug could derive the wrong actor | Which is why one function produces it, nothing else may, and a test asserts no request input reaches it. |
| The portal now depends on a second service to draw some pages | Only those pages. Every call returns rather than throws, and the quote form, the inbox and the landing page do not touch hostd at all. |
| No caching means the dashboard makes a request per site | Accepted in v1, and the first of the two hostd requests above removes most of it. |
