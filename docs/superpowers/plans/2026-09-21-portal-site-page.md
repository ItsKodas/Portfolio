# Portal site page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/portal/sites/[id]` a real page, so the site names in the dashboard's nav lead somewhere: status and lifecycle, live logs, env files for the operator, and honest placeholders for the three things hostd cannot do yet.

**Architecture:** The same shape as the dashboard. A tested module gathers, the page arranges, and `ui/` supplies every part. Tabs are the existing `Tabs` component. What hostd cannot serve is shown as a disabled tab that explains itself rather than a tab that is missing.

**Tech Stack:** TypeScript, Next.js 15 App Router server components, the `ui/` library, vitest.

**Spec:** the design is a mockup, https://claude.ai/artifact/XLHxrDVisXjvGYTC5Xto3M. The client module is `docs/superpowers/specs/2026-09-20-portal-hostd-client-design.md`.

## Global Constraints

- **No em dashes** (U+2014) anywhere: code comments are the only exception, per `CLAUDE.md`.
- **House style:** four-space indent, no semicolons, single quotes, named exports.
- **Every colour is a token**, enforced by `ui/palette.test.ts` over `ui/`. The same rule applies to this page's stylesheet.
- **Read every field name and type from the source**, never from this plan's prose or from the mockup. Four contracts in this project have already been written the wrong way round, one of which would have failed silently. If what you read disagrees with this plan, the source wins and you stop and say so.
- Do not change `ui/`. Do not add a dependency.
- Tests run with `npx vitest run`.

## Two things hostd does not expose, read from its source

**`GET /projects/:id` does not answer a project.** It answers `StatusReply`, which is `{ ok: true, services: ServiceStatus[] }` and carries no `id`, `name` or `valid` (`hostd/src/api/routes.ts`, the `status` case). `server/hostd/projects.ts` types `getProject` as returning `Project`, which is wrong and is Task 1.

**Nothing exposes a project's environments.** The registry holds `environments: Map<EnvironmentName, EnvironmentEntry>` (`hostd/src/shared/registry.ts`), but the list handler builds each entry as `{ id, name, capabilities, valid, reason?, status }` and the status reply is a flat list of services. So **the two environment panels the mockup shows have no data source today.**

This plan therefore builds the Overview around what exists: the services hostd reports, which are the live environment's. Write the panel so a second environment slots in beside it later rather than so it has to be rebuilt.

**Check this again before you start.** hostd's deploy phase is being built in parallel and deploys are per environment, so environments may well be exposed by the time you read this. If a project entry carries them, use them and note in the PR that you did.

---

### Task 1: Make `getProject` tell the truth

**Files:**
- Modify: `server/hostd/projects.ts`, `server/hostd/projects.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/hostd/projects.test.ts`:

```ts
describe('getProject', () => {
    it('returns the services hostd actually answers with', async () => {
        // GET /projects/:id answers StatusReply, which is services and nothing else. It was typed as a
        // whole Project, so name and valid could never have been read from it.
        const services = [{ service: 'asot-web', role: 'site', state: 'running', health: null, startedAt: null, restartCount: null, image: null }]
        const { fetchImpl, calls } = fakeFetch({ ok: true, services })
        const result = await getProject(config, admin, 'asot', fetchImpl)
        expect(result).toEqual({ ok: true, value: services })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/asot')
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, services: [] })
        expect(await getProject(config, admin, 'nope!', fetchImpl)).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })
})
```

Reuse the `fakeFetch`, `config` and `admin` helpers already at the top of that file rather than adding new ones.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run server/hostd/projects.test.ts`
Expected: FAIL on the first case, because `getProject` hands back the whole body rather than its `services`.

- [ ] **Step 3: Change the signature**

In `server/hostd/projects.ts`, make `getProject` return `Promise<HostdResult<ServiceStatus[]>>` and unwrap
`services` the way `listProjects` unwraps `projects`. Leave a comment saying what the endpoint actually
answers, so nobody re-widens the type from the design document's prose.

- [ ] **Step 4: Confirm and commit**

Run: `npx vitest run server/hostd && npx tsc --noEmit`

```bash
git add server/hostd/projects.ts server/hostd/projects.test.ts
git commit -m "Type getProject as what hostd answers"
```

---

### Task 2: Gather one site

**Files:**
- Create: `app/(portal)/portal/sites/[id]/site.ts`, `site.test.ts`

**Interfaces:**
- Produces: `type SiteView`, `gatherSite(deps, id): Promise<SiteView>`

- [ ] **Step 1: Write the failing test**

Create `app/(portal)/portal/sites/[id]/site.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { gatherSite } from './site'

const service = (state: string) => ({
    service: 'asot-web', role: 'site' as const, state,
    health: null, startedAt: null, restartCount: null, image: null,
})

function deps(over: Record<string, unknown> = {}) {
    return {
        who: async () => ({ caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }),
        config: () => ({ ok: true as const, value: { url: 'http://hostd-api:8080', token: 'a'.repeat(32) } }),
        listProjects: async () => ({ ok: true as const, value: [{ id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle', 'logs'] }] }),
        getProject: async () => ({ ok: true as const, value: [service('running')] }),
        owns: async () => true,
        ...over,
    }
}

describe('gatherSite', () => {
    it('finds the site and its services', async () => {
        const view = await gatherSite(deps(), 'asot')
        expect(view.kind).toBe('site')
        if (view.kind === 'site') {
            expect(view.name).toBe('ASOT')
            expect(view.services).toHaveLength(1)
        }
    })

    it('refuses a site this client does not own, before asking hostd for it', async () => {
        const view = await gatherSite(deps({
            who: async () => ({ caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }, clientId: 'cl_8F2K1ABC' }),
            owns: async () => false,
            getProject: async () => { throw new Error('should not be asked') },
        }), 'asot')
        expect(view.kind).toBe('forbidden')
    })

    it('says not found when hostd has no such project, rather than showing an empty page', async () => {
        const view = await gatherSite(deps({ listProjects: async () => ({ ok: true as const, value: [] }) }), 'asot')
        expect(view.kind).toBe('missing')
    })

    it('still shows the site when its status could not be read', async () => {
        const view = await gatherSite(deps({
            getProject: async () => ({ ok: false as const, code: 'agent-unavailable', message: 'the agent is not answering' }),
        }), 'asot')
        expect(view.kind).toBe('site')
        if (view.kind === 'site') {
            expect(view.services).toEqual([])
            expect(view.trouble).toBeTruthy()
        }
    })

    it('tells a client nothing about which part of the machine failed', async () => {
        const view = await gatherSite(deps({
            who: async () => ({ caller: { actor: 'client:cl_X', user: 'cl_X' }, clientId: 'cl_X' }),
            getProject: async () => ({ ok: false as const, code: 'agent-unavailable', message: '/run/hostd/agent.sock is not answering' }),
        }), 'asot')
        if (view.kind === 'site') expect(view.trouble).not.toContain('/run/hostd')
    })

    it('carries whether the viewer is the operator, which decides the tabs', async () => {
        const view = await gatherSite(deps(), 'asot')
        if (view.kind === 'site') expect(view.isAdmin).toBe(true)
    })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run "app/(portal)/portal/sites"`
Expected: FAIL, cannot resolve `./site`.

- [ ] **Step 3: Write it**

Create `app/(portal)/portal/sites/[id]/site.ts`. It imports no `server-only`: every effect is injected and
the test runs it directly, the same as `app/(portal)/portal/home.ts`.

The shape, with the field names read from `server/hostd/projects.ts` rather than from here:

```ts
export type SiteView =
    | { kind: 'anonymous' }
    | { kind: 'forbidden' }
    | { kind: 'missing' }
    | { kind: 'site', id: string, name: string, isAdmin: boolean, capabilities: string[], services: unknown[], trouble: string | null }
```

The order of operations matters and is the whole point of the module:

1. No session gives `anonymous`.
2. A client who does not own this project gives `forbidden`, **decided before hostd is asked anything**. hostd checks ownership too, and that second check is what makes this one a first line rather than the only one.
3. The project is found by looking through `listProjects`, which is already scoped to what the caller may see, so a client cannot learn that another client's project exists. Not found gives `missing`.
4. Status is fetched separately and may fail. A failure leaves `services` empty and puts a reason in `trouble`, and the page still renders.
5. `trouble` is hostd's own words for the operator and a fixed sentence for a client. Use `forClient` from `server/hostd/errors.ts` rather than writing a new one.

- [ ] **Step 4: Confirm and commit**

Run: `npx vitest run "app/(portal)/portal/sites"`
Expected: PASS, six tests.

```bash
git add "app/(portal)/portal/sites"
git commit -m "Gather one site for the portal"
```

---

### Task 3: The page, and the tabs

**Files:**
- Create: `app/(portal)/portal/sites/[id]/page.tsx`, `site.module.css`
- Modify: `app/(portal)/portal/page.tsx` (the nav links)

- [ ] **Step 1: Point the dashboard at the right URL**

The dashboard links to `/portal/${site.id}`. That segment now has static siblings (`quotes`, `clients`,
`ui`), and a site whose id was `quotes` would be unreachable. Change the links to `/portal/sites/${site.id}`.

- [ ] **Step 2: Write the page**

`app/(portal)/portal/sites/[id]/page.tsx` is a server component that calls `gatherSite`, handles the three
non-site outcomes (`redirect('/portal/sign-in')`, `notFound()` for both `forbidden` and `missing`), and
otherwise renders the `Shell` with the same nav the dashboard builds.

**`forbidden` and `missing` must render identically.** Answering "no such site" to a client asking about
somebody else's project confirms it does not exist; answering "not yours" confirms it does. Both are
`notFound()`.

The tab strip is the existing `ui/Tabs/Tabs.tsx`. Selecting a tab is a URL, not client state, so the page
reads `searchParams` and each tab is a link. That keeps the page a server component and makes a tab
shareable and reloadable.

Available tabs, by role:

| Tab | Operator | Client | State |
| --- | --- | --- | --- |
| Overview | yes | yes | works |
| Logs | yes | yes | works |
| Environment | yes | no | works |
| Deploys | yes | yes | disabled |
| Backups | yes | yes | disabled |
| Domains | yes | no | disabled |

- [ ] **Step 3: Build Overview**

The services hostd reports, as `Row`s: the service name in mono as the title, its state as the aside, and
`tone="crit"` when the state is not `running`. Above them, a short `StatStrip` of what is known, and the
lifecycle buttons (`Start`, `Stop`, `Restart`) as `Button`s.

**Wire the lifecycle buttons to a server action that calls `lifecycle` from `server/hostd/projects.ts`.**
A button that looks live and does nothing is worse than no button. If you cannot finish the action within
this task, render them `disabled` with a title saying so, and say in the PR that they are not wired.

Read `ServiceStatus` from `hostd/src/shared/protocol.ts` before writing any field access. `restartCount`
is not `restarts`, and every nullable field is explicitly `null` rather than absent.

- [ ] **Step 4: Confirm and commit**

Run: `npx vitest run && npm run build && npx tsc --noEmit`

```bash
git add "app/(portal)/portal"
git commit -m "Add the site page with its overview"
```

---

### Task 4: Logs

**Files:**
- Create: `app/(portal)/portal/sites/[id]/logs.tsx`

- [ ] **Step 1: Build the client component**

A `'use client'` component that opens an `EventSource` on `/api/sites/${id}/logs?service=...`, collects the
`line` events into state and renders `ui/LogPane`. That route already exists and already derives the actor
from the session, so this component sends no token and names no client.

hostd closes a follow stream after an hour and expects a reconnect carrying `since=<last timestamp>`. Keep
the last line's timestamp and pass it when reopening. The relay passes it through.

Close the `EventSource` in the effect's cleanup. An un-closed stream per navigation is how a portal ends up
holding four connections to one container, which is hostd's documented limit.

- [ ] **Step 2: Handle the states that are not "lines arriving"**

Connecting, reconnecting, and refused. A refusal comes back as an HTTP error before the stream opens, so the
`error` handler must distinguish "closed, will retry" from "never going to work" as far as it can, and say
which. `LogPane` already renders "Nothing yet." for an empty list.

- [ ] **Step 3: Confirm and commit**

Run: `npm run build && npx tsc --noEmit`

```bash
git add "app/(portal)/portal/sites"
git commit -m "Stream a site's logs into the portal"
```

---

### Task 5: Environment, for the operator only

**Files:**
- Create: `app/(portal)/portal/sites/[id]/env.tsx`

- [ ] **Step 1: List the files**

Server-side, call `listEnvFiles` from `server/hostd/env.ts`. An entry is
`{ path, example: string | null, bytes: number }`, read from the source, not from here.

Render the file list as buttons and the chosen file's contents in a textarea, using `ui/Field` with
`as="textarea"`.

- [ ] **Step 2: Save through a server action**

`writeEnvFile` takes the whole text. Its body is JSON `{ text }`, which `server/hostd/env.ts` already
handles, so the action passes the string and nothing else.

**Say what saving does before it is done.** The copy from the mockup: saving writes the file and restarts
the containers, the environment is unavailable for about twenty seconds, and visitors see the holding page.

- [ ] **Step 3: Say what this file is not**

Carry the line from the design: it is kept out of every backup, it is not among the client's downloads, and
it never leaves the dedi.

- [ ] **Step 4: Confirm and commit**

Run: `npx vitest run && npm run build && npx tsc --noEmit`

```bash
git add "app/(portal)/portal/sites"
git commit -m "Edit a site's env files from the portal"
```

---

### Task 6: The three tabs that cannot work yet

**Files:**
- Modify: `app/(portal)/portal/sites/[id]/page.tsx`
- Modify: `ui/Tabs/Tabs.tsx`, `ui/Tabs/Tabs.test.tsx` (the one permitted change to `ui/`)

Deploys, Backups and Domains are designed and hostd implements none of them. They are shown and disabled,
because a missing tab reads as a product that cannot do the thing and a disabled one reads as a product that
will.

- [ ] **Step 1: Teach `Tabs` about unavailable tabs**

Add an optional `disabled?: boolean` to a tab. Render it with **`aria-disabled="true"`, never the `disabled`
attribute.** A `disabled` button cannot be focused, so a keyboard user could never reach the explanation of
why it is off, which defeats the point of showing it at all.

It stays in the roving tabindex and stays selectable. Selecting it shows its panel, which says what it is
waiting for.

Write the test first, and assert both halves: that it carries `aria-disabled`, and that it is still
reachable by the arrow keys.

- [ ] **Step 2: Write the panels**

One short `Callout` each, in the client's language rather than the stack's. For example, for Deploys:
"Not here yet. Deploys are designed and being built. When they arrive this is where you will see what
changed, and roll back if it needs it."

Do not promise a date.

- [ ] **Step 3: Confirm and commit**

Run: `npx vitest run ui/Tabs && npx vitest run && npm run build && npx tsc --noEmit`

```bash
git add ui/Tabs "app/(portal)/portal/sites"
git commit -m "Show the tabs hostd cannot serve yet, disabled and explaining themselves"
```

---

### Task 7: Look at it

- [ ] **Step 1: As the operator**

Sign in, open `/portal`, click a site. Check each tab. Confirm the lifecycle buttons do what they say on a
site you do not mind restarting. Watch the logs actually stream.

- [ ] **Step 2: As a client**

Confirm the site they own opens, that Environment and Domains are absent rather than disabled, and that
another client's site id gives the same "not found" as a site that does not exist.

- [ ] **Step 3: On a phone**

The tab strip scrolls sideways rather than wrapping. The rail drops under the content rather than
disappearing.

- [ ] **Step 4: Record what you found**

In the PR, whether or not you fixed it.

---

## What this plan does not do

**It does not show two environments.** hostd exposes none, which is recorded at the top. The Overview is
built so a second panel slots in beside the first when it does.

**It does not convert the moved admin pages.** They stay MUI. That is the next pass.
