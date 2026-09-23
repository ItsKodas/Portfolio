# Admin "New site" from the portal

Date: 2026-09-23. Status: approved in chat.

## Goal

An admin can create and provision a new hosted site from the portal sidebar, without editing
`projects.yaml` by hand or calling hostd with curl.

## What the admin fills in

A "New site +" button at the bottom of the sidebar (admin only, on the dashboard and on every site page)
opens a modal with:

| Field | Default | Rule |
|---|---|---|
| Name | | 1 to 100 characters |
| Project id | slug of the name | hostd `PROJECT_ID` |
| Folder in `/var/www` | the project id | one path segment, same grammar as the id |
| Client | None (admin managed) | an existing portal client, or none |
| Repo | | ssh or https git URL |
| Account | default (`GITHUB_TOKEN`) | a fetcher credential name |
| Branch | `main` | plain branch name |
| Compose files | `docker-compose.yml` | 1 to 8 relative paths |
| Features | lifecycle, logs, env, deploy | hostd `CAPABILITIES`, same list and notes as Settings |
| WebSockets, Cloudflare Flexible SSL | off | the Settings switches |
| Domain | empty | lowercase hostname, optional |
| Certificate | letsencrypt | letsencrypt or cloudflare-origin, only with a domain |
| Deploy after creating | off | |

The branch is typed rather than picked: hostd can only list branches for a registered project. A wrong
branch fails the clone and the create rolls back.

## hostd

### Client becomes optional

`ProjectEntry.client` becomes `string | null`. A registry entry with no `client:` key is valid and
belongs to no client: `policy.ts` already compares it against a client actor's id, so no client can see
or act on it. The admin sees it as before.

### Create takes the rest of the entry

`POST /projects` and `ProvisionCreateArgs` gain optional fields:

- `client` optional (omitted means none).
- `dir`: one segment under `/var/www`, default the id. The existing `exists` check, domain check and
  compose name check (against `basename(dir)`) are unchanged.
- `compose`: 1 to 8 relative paths (no `..`, no leading `/`), default `['docker-compose.yml']`. All of
  them go to `docker compose config` at resolve time, and to the registry as the environment's `compose`.
- `capabilities`: subset of `CAPABILITIES`, default none (today's behaviour), written at project level.
- `websockets`, `flexibleSsl`: booleans, default false, written on the live environment.

### Vhost at create

When the create succeeded and a domain was given, api does what an adopt of a newly provisioned site
does: mint the environment's token, ask the agent for an adopt preview, and if no other file claims the
hostname, adopt with nothing to disable, then record the hostnames as written. If a file already claims
the name, or Apache refuses, the site stays created and the reply carries
`vhost: { ok: false, message }`; the admin finishes it from the Domains tab. A success carries
`vhost: { ok: true }`. No domain means no `vhost` key.

## Portal

- `server/hostd/create.ts`: `createProject(config, caller, input)` posting to `/projects`, checking the
  id and hostname first like `writeSettings` does.
- `app/(portal)/portal/sites/features.ts`: the capability and switch lists moved out of `settings.tsx`,
  shared with the modal.
- `app/(portal)/portal/newSite/`: `NewSiteButton` (client component, owns the `Dialog`), a zod schema,
  and `createSiteAction` (admin only). The action calls `createProject`, then links the `Site` row in
  Postgres when a client was picked, then deploys live when asked, and returns the new id plus any
  warnings. The client navigates to `/portal/sites/<id>` and shows the warnings.
- Both sidebars render the button under the site list when the viewer is admin. The client list and
  credentials are fetched on the server for admins only.

If hostd refuses, nothing is written to Postgres. If the link or the deploy fails after hostd succeeded,
the site exists and the warning says what is left to do.

## Testing

- hostd (`node:test`): create body and protocol parsing of the new fields; registry parse with no client;
  `add-project` writing capabilities, compose, flags and no client; `createProject` with a custom dir and
  several compose files; api create writing the vhost, and reporting without rolling back when it cannot.
- Portal (Vitest): `createProject` request shape and pre-checks; `createSiteAction` admin gate, link
  only with a client, deploy only when asked; dom test of the modal's validation and payload.
