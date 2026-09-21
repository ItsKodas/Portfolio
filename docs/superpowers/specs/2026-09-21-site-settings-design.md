# Site settings: configuring a project from the portal

**Date:** 2026-09-21
**Status:** approved

## The problem

Every field that decides what a site can do lives in one hand-edited file on the dedi,
`hostd/registry/projects.yaml`. hostd's registry writer exists, and it is careful (it edits the YAML
document, re-parses the result with the same validator it loads with, refuses anything it would not
load, and renames atomically), but it can only do six things: add a project, add an environment, set
`deployed`, set `branch`, remove a project, remove an environment.

Nothing can change `capabilities` or `repo`. So today the Environment tab and the Deploys tab are dead
for all five real sites, and the only way to bring them to life is to SSH in and edit YAML. Worse, the
one change kind that looks like it would help, `set-branch`, refuses on all five: it edits
`environments.<name>.branch`, and a project registered the live-only way (`dir` plus `upstream`, no
`environments` block) has no such node. hostd answers `arbysauto has no live environment`.

This adds a Settings tab that changes the three fields standing between a hand-enrolled site and a
working portal, and teaches the writer the one structural conversion those five entries need.

## Scope

**In:** `capabilities`, `repo`, and each environment's `branch`. Plus converting a live-only entry to the
`environments` shape, which setting a branch requires. In practice that means live today, since nothing
here adds a test environment, but the shape is per environment because a project that has one should not
need a second design.

**Out, deliberately:** `services`, `storage`, `limits`, `compose`, and an environment's `domain`, `port`
and `certificate`. They change when a site's compose file changes, which is rare, and each one costs a
writer operation, a control and its own tests. They stay hand-edited until there is a reason.

**Out, on purpose and for good:** `client` and `dir`. `client` moves a site into a different person's
portal, and `dir` re-points hostd at another tree while the containers already running stay where they
are, so a later stop or deploy acts on the wrong one. Neither is a mis-click anyone should be one away
from. They stay in the file on the dedi.

## What the operator sees

A **Settings** tab, last in the strip on `/portal/sites/[id]`, operator only. Absent for a client rather
than disabled, the same as Environment and Domains: a client has no business seeing what their site's
capabilities are, let alone that they could be different.

Three sections and one Save.

**capabilities.** Eight checkboxes, one per entry in hostd's `CAPABILITIES`
(`lifecycle`, `logs`, `files`, `backups`, `domains`, `provision`, `env`, `deploy`). The four hostd can
act on today are plain. The four it cannot (`files`, `backups`, `domains`, `provision`) are marked as
designed but not built, so that ticking one is not mistaken for switching a feature on. `provision` says
what it actually grants, which is that this project can be re-provisioned and removed through the API.

**repo.** One field, an ssh or https Git URL, clearable. Beside it, the sentence hostd cannot check for
itself: a deploy needs a Git repository already at `<dir>/.git`, and hostd only discovers there is not
one when the deploy runs.

**live.** One field, `branch`. `dir` and `port` beside it, read only, because they are how the operator
knows they are configuring the right thing. A site with a `test` environment shows its branch too; it is
the same control per environment rather than a second design.

Saving is one button for all three sections. One save, one write, one audit line.

## hostd

### One new change kind

```ts
| {
    kind: 'configure'
    id: string
    capabilities?: Capability[]
    repo?: string | null
    branches?: Partial<Record<EnvironmentName, string | null>>
}
```

One kind rather than three, because `RegistryWriter.write` takes one `Change` per write and serialises
them. Three changes would be three reads, three validations, three files on disk and a half-applied save
if the second failed. This is one edit to the document, one `parseRegistry` of the result, one atomic
rename.

Fields absent from the change are left alone. `repo: null` deletes the key. A branch of `null` deletes
that environment's `branch`, which is how an environment stops deploying.

`edit()` gains a `configure` case that, in order:

1. Refuses when the project is not in the document.
2. Converts to the `environments` shape, if a branch was asked for and the entry has no `environments`
   node. See below.
3. Sets `capabilities` to the list given, replacing whatever was there.
4. Sets or deletes `repo`.
5. Sets or deletes each named environment's `branch`, refusing when the entry has no such environment.

No grammar checks in `edit()` beyond those. `applyChange` re-parses the whole document with
`parseRegistry` immediately afterwards, which already refuses an unknown capability, a repo that is not
an ssh or https Git URL, a branch that is not a plain branch name, and a branch with no repo to fetch it
from. One rule about what a field may be, in the validator, rather than two that could drift. This is
the same reasoning the existing `set-branch` case records.

### The conversion

Given a branch for a project written the live-only way, `configure` first rewrites the entry:

- Reads the entry's own `dir`, `compose` (absent means `docker-compose.yml`) and `upstream`.
- Writes `environments: { live: { dir, compose, port } }`, where `port` is `upstream`'s port. `compose`
  is written only when the entry had one.
- Deletes the project-level `dir`, `compose` and `upstream`, which `parseRegistry` refuses to hold
  alongside `environments` (`dir and environments cannot both be given`).

`upstream`'s host is not carried anywhere. There is no per-environment host field, and `parseRegistry`
already answers `127.0.0.1` for an environments-shaped entry. An entry whose `upstream` host was
something other than the loopback address is therefore changed by this conversion, not merely reshaped.
It refuses rather than guessing when the entry has no `upstream` to take a port from.

It runs once per project and only when a branch is being set. It is invisible in the portal and visible
in the file, which keeps its comments and formatting because the writer edits the document rather than
re-serialising the parsed registry.

### One new verb, one new route

`configure` joins `AgentRequest` as `{ verb: 'configure', project, args }`, where args carry the three
optional fields. The agent's `handle` runs the same `checkStructure` every other project verb runs and
then calls the writer.

`PUT /projects/:id/settings` on api, body:

```json
{ "capabilities": ["lifecycle", "logs", "env", "deploy"], "repo": "git@github.com:ItsKodas/arbysauto.git", "branches": { "live": "main" } }
```

Every key optional. Parsed by a `parseSettingsBody` beside the existing body parsers, which refuses
anything that is not a list of strings, a string or null, and an object of environment names to strings
or null. It checks shapes, not grammar: grammar is the validator's.

### Policy

`configure` goes in `ADMIN_ONLY` beside `provision`, `env` and `deploy`.

Its `VERB_CAPABILITY` entry is **null**, and that is the load-bearing decision. Gating the verb that
edits capabilities on a capability would mean a project with none could never be given any, which is
exactly the project that needs it.

Audited like every other write, with the project as the target.

### What it cannot reach

An entry `parseRegistry` could not parse at all is not in `registry.projects`, so `checkStructure`
refuses it as `invalid-project`, the same as every other verb. A broken entry is still fixed in the file
on the dedi. The portal says so rather than offering a form that will be refused.

### The list gains `repo`

The Settings form has to show the repo it is editing, and nothing answers it today: a list entry carries
`id`, `name`, `capabilities`, `environments`, `valid`, an optional `reason` and an optional `status`.

`repo` is added to the entry, for the operator only, exactly as `environmentsFor` already withholds
`dir`, `composePaths` and `port` from a client. A client has no use for the URL of a repository they
cannot reach, and it is the kind of detail that belongs to the machine rather than to their site.

`server/hostd/projects.ts` gains `repo?: string | null` on `Project`, with the comment saying it is
answered for the operator alone.

## The portal

**`app/(portal)/portal/sites/[id]/settings.tsx`**, a client component, given the project's current
capabilities, repo and environments by the page. `app/(portal)/portal/sites/[id]/actions.ts` gains
`saveSettingsAction(id, settings)`, which goes through the same `allow(id, true)` gate `saveEnvAction`
uses: the operator check is re-derived from the session there, not trusted from the page that rendered
the form.

**`server/hostd/settings.ts`** holds the one call, `writeSettings(config, caller, id, settings)`,
built the same way `server/hostd/env.ts` builds its writes, with the project id checked against hostd's
own id grammar before it reaches a URL.

The form keeps what was typed when a save is refused, shows hostd's own words to the operator, and
calls `router.refresh()` on success so the tabs that the capabilities gate re-render enabled.

## Also in scope

The **Environment** tab is currently shown to the operator whatever the registry says, so it reads as
broken rather than as switched off until `env` is ticked: hostd answers `env is not enabled for
arbysauto` and the panel shows a refusal. It should be disabled like Deploys is, and say that Settings
is where that is turned on. Small, and it is the same confusion this tab exists to end.

## Testing

**The writer** gets the heaviest coverage, being the only thing here that can corrupt the registry:

- capabilities replaced wholesale, including down to an empty list
- a repo set, and a repo cleared
- a live-only entry converted, with its `compose` list carried across in order
- a live-only entry converted when it had no `compose` key, which means the default
- a conversion refused when the entry has no `upstream` to take a port from
- a branch set on an entry that already has `environments`, with no conversion
- a branch refused for an environment the entry does not have
- an unknown capability, a bad repo URL and a bad branch name each refused by the validator, with the
  file on disk unchanged
- a branch with no repo refused, which is `parseRegistry`'s own `branch needs repo` rule
- comments and formatting elsewhere in the file preserved across a write

**The route:** a client refused ahead of everything else, a malformed body refused before the agent is
called, and a well-formed body reaching the agent with the fields it was given.

**The tab:** absent for a client, disabled controls with the reason when the entry is invalid, what is
sent when Save is pressed, and what is shown when the save is refused.

**The Environment tab:** disabled without the `env` capability, enabled with it.

## What this deliberately does not do

- **It does not restart anything.** Ticking `lifecycle` does not start a site, and changing a branch does
  not deploy. The next poll picks up a new branch, or Deploy now does.
- **It does not create environments.** Adding a `test` environment is provisioning, which already has its
  own API and its own reasons to be careful. The conversion here reshapes the live environment that
  already exists; it does not add a second one.
- **It does not validate the repo exists.** hostd finds out when it fetches. The tab says so.
- **It does not edit a broken entry.** An entry the registry could not parse is fixed on the dedi.
