# hostd provisioning and deployment design

Date: 2026-09-20
Status: approved design, not yet implemented
Extends: `docs/superpowers/specs/2026-09-18-mail-stack-design.md` conventions and
`docs/superpowers/specs/2026-09-20-hostd-design.md` (phase 1 of which is deployed and running)

## Context

hostd runs on the dedi and controls client sites: status, start, stop, restart and logs, with a registry
the operator maintains by hand, a permission model in two layers, and an audit log. Phase 1 went live on
2026-09-20 and currently drives one real site.

Today a site is created by hand: clone the repo into `/var/www/<id>`, write its env files, run
`docker compose up -d`, add a vhost, then add an entry to `hostd/projects.yaml`. This phase moves that
into hostd, and adds the thing the operator actually wants day to day: a site that redeploys itself when
a commit lands on its branch.

Every client repo already carries its own compose file, so nothing is generated: the work is cloning,
preparing env files, assigning a port, writing a vhost, and then keeping the running containers in step
with a branch.

## Scope

### In scope

- Creating a project from a Git repository, including its folder, env files, port, vhost and registry entry
- Two environments per project, live and test, each with its own branch, folder, env files, containers,
  database and domain
- Editing env files through the portal, confined to one environment's folder
- Polling GitHub and deploying automatically when the tracked branch moves
- Building before swapping, a maintenance page during the swap, a health check after it, and automatic
  recovery when that check fails
- One-click rollback to the last healthy commit, and branch switching
- Deploy history, and the Git commit list, both readable by the client
- A default resource cap per site
- hostd writing `projects.yaml` and Apache vhosts, both from validated fields
- Certificates per environment: Let's Encrypt, or a Cloudflare Origin certificate

### Not in scope

- General file browsing, upload and download (phase 3 of the hostd design)
- Backups (phase 2)
- Restoring a backup, or any destructive operation on a database
- Clients deploying, rolling back, switching branch, or reading env files
- Generating or editing compose files, Dockerfiles or source code
- Creating DNS records. hostd verifies domains, never creates them
- Operating the operator's own stacks (`horizons`, `mail`, `hostd`), which the registry already refuses

## Decisions

Each was made explicitly with the operator.

**Provisioning is its own phase, borrowing only what it needs.** It pulls forward env-file writing from
phase 3 (env files only, not general file access) and vhosts and certificates from phase 4. Backups and
file browsing stay where they are.

**hostd writes the registry, through a narrow API.** Until now it has only read `projects.yaml`. The portal
calls "create project" with a name, client, repo, branch and domain; hostd derives the id, folders and
ports itself, validates every field, writes the entry atomically and re-runs the existing guards. The portal
can never supply a path, a port or a capability list. This keeps the rule that hostd trusts only what it
validated, and it is what makes one-click creation possible at all.

**hostd writes the vhost and reloads Apache**, through the mechanism the domains design already defines:
the agent writes the file and a `.reload` trigger, and the reload is refused unless Apache's own config test
passes. A failed test removes the file and reloads nothing, so one bad site can never take every site
offline.

**Auto-deploy everywhere, live sites included.** The operator chose this over a click-to-deploy step for
live sites. The design carries the weight that removes: build before swapping, health check after, and an
automatic return to the previous version when the check fails.

**Poll GitHub, no webhooks.** Every 2 minutes per environment. Nothing new is exposed to the internet, it
works the same for every repo, and it survives the dedi's dynamic IP. The cost is that a deploy can start
up to 2 minutes after a push.

**Build into a new copy, then swap.** A failed build never touches the running site, and rollback is
pointing back at the previous copy and image rather than rebuilding. The cost is two working trees per
environment on disk.

**A maintenance page, driven by a flag file with a fallback.** hostd writes a flag before the swap and
removes it after; Apache serves the maintenance page when the flag exists, and also when the site is
unreachable. So a planned deploy and an unplanned outage both look tidy, and the page can say which it is.

**Live and test are environments of one project**, at `/var/www/<id>` and `/var/www/<id>-test`, each one
segment below `/var/www` so the registry's existing path rule is unchanged. A test environment's domain
defaults to `test.<live domain>`.

**hostd assigns ports.** It keeps a range and passes the port to compose as an environment variable, which
is how the operator's compose files already read them (`${WEB_PORT:-5008}`). A test environment therefore
gets its own port without anyone thinking about it.

**A new site waits for the operator before its first start.** After cloning, hostd lists the env files it
found and stops in `needs-setup`. Nothing starts with a half-filled env file, because an application that
boots without its settings can write a broken schema to a database before it fails.

**A test environment's env files are copied from live, with the obvious values changed**: the site's own
URL becomes the test domain, and anything pointing at the live database points at the test one. Everything
else is shown for review before the first start, because a copy means live credentials now exist twice.

**One GitHub token for every repo.** The operator chose this over a deploy key per site. It must be a
fine-grained personal access token limited to the client repositories, read-only.

**Env files are edited in the portal**, per environment, any `.env`-style file inside that environment's
folder including ones in subfolders and variants such as `.env.test`, with any `.env.example` shown beside
them. Writes are confined to env files, so this path can never change code.

**Clients never deploy.** They can see deploy history and the commit list for their own site. Deploy,
rollback, branch switching and env access are the operator's alone.

## Architecture

### New capabilities

Added to the registry's capability list, which already carries `lifecycle`, `logs`, `files`, `backups` and
`domains`:

| Capability | Covers |
| --- | --- |
| `provision` | Create and delete projects and environments |
| `env` | List and edit env files in one environment |
| `deploy` | Poll, deploy, roll back, switch branch, read history |

A project enrolled by hand, with no `repo`, simply does not get `deploy`, and keeps working exactly as it
does today.

### The registry entry

```yaml
pmpc-group:
  client: cl_pmpc
  name: PMPC Group
  repo: git@github.com:ItsKodas/pmpc-group.git
  environments:
    live:
      dir: /var/www/pmpc-group
      branch: main
      domain: pmpcgroup.com.au
      port: 5008
      certificate: letsencrypt          # letsencrypt | cloudflare-origin
      deployed: 3f7c1a2                 # written by hostd, not the operator
    test:
      dir: /var/www/pmpc-group-test
      branch: develop
      domain: test.pmpcgroup.com.au
      port: 5108
      certificate: letsencrypt
  compose: docker-compose.yml
  services:
    web: { role: site }
  storage: {}
  limits: { memory: 1g, cpus: 1 }
  capabilities: [lifecycle, logs, deploy, env]
```

The existing single-environment shape stays valid and means "live only", so today's entries need no
rewriting. `dir` remains one segment below `/var/www` for every environment.

### Writing the registry

Only the agent writes it, and only through one function: read, apply a validated change, write to a
temporary file in the same directory, `fsync`, rename over the original. The entry is validated by the same
shared code that validates a loaded file, before the write, so a write can never produce a file hostd would
refuse to load. A write that would produce an invalid registry is refused and nothing changes.

Concurrent writes are serialised by the same lock that already guards a project.

### Ports

hostd keeps a range (`5000-5999` by default, configurable) and, when creating an environment, picks the
lowest free port: free meaning not in any registry entry and not listening on the host. The port is passed
to compose as `WEB_PORT` (configurable per project as `portEnv`) and recorded in the entry. Exhaustion is a
refusal with a clear reason.

### Certificates

Per environment:

- `cloudflare-origin`: the existing domains design, an Origin certificate behind a proxied CNAME.
- `letsencrypt`: a certificate obtained on the dedi for that hostname, renewed automatically, for clients
  who point their domain straight at the server. The vhost template takes the certificate paths, so the
  rest of it is identical.

A domain that does not yet resolve to the dedi leaves the environment running on its port with the vhost
marked pending, rather than a half-written Apache config: "waiting for DNS", not "broken".

### Maintenance page

`/var/www/hostd-maintenance/` holds one page, served by Apache. The vhost template gains a rule: if
`/run/hostd/maintenance/<id>-<env>` exists, or the upstream cannot be reached, serve that page with a 503
and `Retry-After`. The page says whether an update is in progress or the site is temporarily unavailable,
based on which of the two conditions applied.

## Provisioning a site

1. **Create** (`POST /projects`), with name, client, repo, branch, domain and certificate mode. hostd
   derives the id from the name, refuses it if taken or reserved, assigns a port, and creates the folder.
2. **Clone** the repo at the branch, using the token. A failure here leaves nothing behind: the folder is
   removed.
3. **Read the compose file**, resolve it, and work out its services. The same guards that run for a
   hand-enrolled project run here, including the compose project name check.
4. **Find env files**: every `.env`-style file in the tree, and every `.env.example` beside one. The
   project enters `needs-setup`.
5. **Operator fills them in** through the env endpoints.
6. **Start** (`POST /projects/:id/live/start`), which builds, starts, and health-checks like any deploy.
7. **Vhost and certificate** are written once the domain resolves to the dedi, then verified as the domains
   design already describes.

Adding a test environment is the same flow from step 1, with the env files seeded from live rather than
empty.

Deleting a project stops its containers, removes its vhost, and removes its registry entry. It requires the
project's name typed back. It never deletes the project folder, its volumes or its databases: those are
removed by hand, so that a mistaken click cannot destroy a client's data.

## Deploying

### Noticing

Every 2 minutes, for each environment with `deploy` and a `repo`, hostd asks GitHub for the tip of the
tracked branch. Different from `deployed` means a deploy. One deploy per environment at a time; commits that
land mid-deploy are picked up by the next run, newest first.

### The steps

1. **Prepare.** Fetch, and check the new commit out into a fresh working tree beside the current one
   (`<dir>.next`). A fetch or checkout failure ends the deploy here, with nothing changed.
2. **Carry the env files across** from the running copy, since they are not in the repo.
3. **Build.** `docker compose build` in the new copy. The site is still serving the old version.
4. **Swap.** Write the maintenance flag, `docker compose down` the old copy, move the trees
   (`<dir>` becomes `<dir>.prev`, `<dir>.next` becomes `<dir>`), `docker compose up -d`, remove the flag.
5. **Health check.** Every service running, and the site answering on its port within 60 seconds.
6. **Record.** Commit, subject, actor, duration and outcome, to the deploy history and the audit log, and
   `deployed` written to the registry.

### When a step fails

Steps 1 to 3 leave the running site untouched: the deploy is marked failed with the reason and the build
output. If step 5 fails, hostd swaps straight back to `<dir>.prev` and its image, checks that it is healthy,
and marks the deploy `rolled-back`. A deploy is never retried automatically: the same commit fails the same
way.

**After three consecutive failures** an environment is paused: polling stops until the operator deploys or
switches branch by hand. Otherwise a repo with a broken build rebuilds every few minutes forever.

**While env files are being edited**, an editing lock is held and a deploy waits for it. This is what stops
a push landing mid-edit and starting a container with half a file.

### Rollback and branch switching

Rollback is the same swap, back to the last commit recorded healthy, using the kept copy and image where
they are still present and a rebuild of that commit where they are not. Branch switching sets the branch
and then runs an ordinary deploy, including its rollback path.

### Disk

Each environment keeps the current tree, the previous one, and nothing older. A deploy refuses to start when
free disk is below a threshold (10 GB by default), because the worst case is a swap that cannot complete.

## The API

Added to the existing endpoints. Admin only unless marked.

```
POST   /projects                                  { name, client, repo, branch, domain, certificate }
DELETE /projects/:id                              { confirm: "<project name>" }
POST   /projects/:id/environments                 { env: "test", branch, domain, certificate }
DELETE /projects/:id/environments/:env

GET    /projects/:id/:env/env                     list env files, with their examples
GET    /projects/:id/:env/env/*path               one file's contents
PUT    /projects/:id/:env/env/*path               save one file

POST   /projects/:id/:env/deploy                  deploy now
POST   /projects/:id/:env/rollback
PUT    /projects/:id/:env/branch                  { branch }
GET    /projects/:id/:env/deploys                 history            (client-readable)
GET    /projects/:id/:env/commits                 the branch's log   (client-readable)
```

Existing endpoints gain the environment in their path, with the old paths continuing to mean `live`.

Every call is audited with actor and user, as now. Env values never appear in the audit log, in a warning,
or in an error message.

## Testing strategy

As in phase 1: the logic is pure and every dependency is injected, so Git, Docker, Apache, the certificate
tool, the clock and the filesystem are fakes in unit tests. `node --test`, tests beside the code.

The behaviours that must be proven:

- a failed fetch, checkout or build never swaps, and the running site is untouched
- a failed health check always swaps back, and the site ends up on the commit it started on
- env files are carried into a new deploy, and never written into the repo tree that Git tracks
- an env value never reaches a log line, an audit entry or an error message
- the registry write is atomic, is validated first, and a refused write leaves the previous file byte for byte
- a port is never assigned twice, and exhaustion is refused clearly
- three consecutive failures pause the environment, and a manual deploy resumes it
- the editing lock holds a deploy, and a deploy holds an edit
- a client is refused deploy, rollback, branch switch and every env endpoint, and each refusal is audited
- a client can read deploy history and the commit list for their own project, and not for another's
- the vhost renders exactly, and a failed config test leaves Apache untouched and the site serving

On the dedi, before any client site gets `deploy`: a rehearsal with a throwaway repo. Create it, fill env
files, start it, push a commit and watch it deploy, break the build deliberately, break the health check
deliberately, roll back, switch branch, add a test environment, delete it all.

## Known risks and accepted weaknesses

| Risk | Why it is accepted, or what limits it |
| --- | --- |
| A build runs the repo's own code as root on the dedi | Inherent to `docker compose build`, and identical to what the operator does by hand. Only the operator can create a project or choose its repo. |
| One token reads every client repo | The operator's choice over per-site deploy keys. A fine-grained, read-only token limited to the client repositories bounds it. |
| hostd can write Apache config and reload it | A fixed template, validated substitutions only, and Apache's own config test gates every reload. |
| Env files hold secrets in plain text on disk | True of every compose deployment today. They are never logged, never returned to a client, and never committed. |
| A test environment starts life holding live credentials | The obvious values are rewritten and the rest is shown for review. The operator decides what a test site may reach. |
| Auto-deploy can ship a broken commit to a live client site | The health check and automatic return to the previous version bound it to seconds of maintenance page, not an outage. A commit that builds and answers but is wrong still reaches visitors. |
| Polling can be up to 2 minutes behind a push | Deliberate, to avoid exposing a webhook endpoint. |
| Let's Encrypt rate limits | Creating several sites in one day can hit them. Failures must read as "try later", not "broken". |
| Two working trees per environment | The cost of a rollback that does not rebuild. Bounded by the disk threshold and by keeping only one previous copy. |

## Later phases

Backups (phase 2) and general file access (phase 3) still stand, and both get simpler once environments
exist. The portal screens that put a UI on all of this are Part 2 and beyond of the client portal, designed
separately.
