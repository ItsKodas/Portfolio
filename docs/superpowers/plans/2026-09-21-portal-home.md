# Portal home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/portal` into the real, role-aware home: the operator sees every site with live status, a client sees their own, both inside the three-zone shell.

**Architecture:** One route, one shell, and `callerFromSession()` deciding what is in it. The page reads hostd through `server/hostd/`, which is already built. No new component: `ui/` has everything this needs.

**Tech Stack:** TypeScript, Next.js 15 App Router server components, the `ui/` library, vitest.

**Spec:** the design is a mockup, https://claude.ai/artifact/XLHxrDVisXjvGYTC5Xto3M. The client module it leans on is `docs/superpowers/specs/2026-09-20-portal-hostd-client-design.md`.

## Global Constraints

- **No em dashes** (U+2014) anywhere: code comments are the only exception, per `CLAUDE.md`.
- **House style:** four-space indent, no semicolons, single quotes, named exports.
- **Every colour is a token**, enforced by `ui/palette.test.ts`. Use `color-mix(in srgb, var(--token) 35%, transparent)` for a tint, never a literal.
- Do not touch `ui/tokens.*`. Do not add a dependency.
- Do not change `server/hostd/`. It is finished and tested; if it is wrong, stop and report.
- **The page never throws because hostd is down.** Every call there returns a result. A portal that cannot draw itself when one service is unreachable is worse than one that says so.

## What already exists

| Piece | Where |
| --- | --- |
| `callerFromSession()`, admin first then client | `server/hostd/session.ts` |
| `listProjects`, `getProject`, `lifecycle`, `assertOwned` | `server/hostd/projects.ts` |
| `getHealth`, the machine's figures | `server/hostd/health.ts` |
| `readHostd`, the settings group | `server/hostd/config.ts` |
| `Shell`, `Row`, `StatStrip`, `Meter`, `Feed`, `KeyValue`, `StatusDot`, `Callout` | `ui/` |

`listProjects` already asks for `status=1`, so one request carries every site's state.

## Decisions

**Tabs that have no backend are shown and disabled.** Deploys, Backups and Domains are designed but hostd implements none of them. They appear, marked unavailable, rather than being hidden: a tab that is missing looks like a product that cannot do the thing, and a tab that is present and honest looks like one that will. **Use `aria-disabled`, not the `disabled` attribute.** A `disabled` button cannot be focused, so a keyboard user can never reach the explanation of why it is off. `aria-disabled` announces it as unavailable while staying reachable, and selecting it shows a short panel saying what it is waiting for. That belongs in the site page's plan; it is recorded here so the decision is not made twice.

**The existing MUI providers stay in `app/(portal)/layout.tsx`.** The sign-in, invite, reset and account pages under that layout are MUI and work. Removing the providers breaks them for no gain, so the new page uses `ui/` inside them and MUI's `CssBaseline` keeps applying its resets underneath, exactly as the gallery already does. The conversion plan removes both together.

**The portal paints its own ground.** `app/globals.css` sets `--background` to the landing scene's navy and Tailwind maps it, so the body ground is not the portal's to change. The shell paints `var(--night)` itself.

---

### Task 1: Let the operator reach the portal

Today `middleware.ts` sends anyone without a **client** cookie to the client sign-in, so the operator, who has an Auth.js session and no client cookie, cannot open `/portal` at all.

**Files:**
- Modify: `middleware.ts`
- Test: `middleware.test.ts`

**Interfaces:**
- Produces: `/portal` reachable by either session; the page still decides what is shown.

- [ ] **Step 1: Write the failing test**

Create `middleware.test.ts` at the repo root:

```ts
import { describe, expect, it } from 'vitest'

import { hasPortalSession } from './middleware'

describe('hasPortalSession', () => {
    it('lets a client through on their own cookie', () => {
        expect(hasPortalSession(['horizons-client'])).toBe(true)
    })

    it('lets the operator through on an Auth.js session cookie', () => {
        // The operator has no client cookie and never will. Without this they are bounced to the client
        // sign-in from their own portal.
        expect(hasPortalSession(['authjs.session-token'])).toBe(true)
    })

    it('accepts the secure names used in production', () => {
        expect(hasPortalSession(['__Secure-horizons-client'])).toBe(true)
        expect(hasPortalSession(['__Secure-authjs.session-token'])).toBe(true)
    })

    it('refuses someone carrying neither', () => {
        expect(hasPortalSession([])).toBe(false)
        expect(hasPortalSession(['some-other-cookie'])).toBe(false)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run middleware.test.ts`
Expected: FAIL, `hasPortalSession` is not exported.

- [ ] **Step 3: Write the implementation**

In `middleware.ts`, add the export above the default function. Keep the existing comment explaining why the
client cookie name is duplicated rather than imported, and add the Auth.js names beside it.

```ts
// Auth.js's own cookie, under both names it uses. Matched by presence only: the edge runtime cannot verify
// it, and it does not need to. This gate decides who may reach a page, and every page decides for itself
// who is actually signed in.
const ADMIN_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token']
const CLIENT_COOKIES = ['horizons-client', '__Secure-horizons-client']

export function hasPortalSession(names: string[]): boolean {
    return names.some(name => CLIENT_COOKIES.includes(name) || ADMIN_COOKIES.includes(name))
}
```

Then replace the client-cookie check in the default function:

```ts
    if (hasPortalSession(request.cookies.getAll().map(cookie => cookie.name))) return NextResponse.next()
    return NextResponse.redirect(new URL(PORTAL_SIGN_IN, request.url))
```

The existing `cookieName` constant becomes unused; remove it and its comment moves to `CLIENT_COOKIES`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run middleware.test.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Check the unit project picks the file up**

`vitest.config.ts`'s `unit` project includes `app/**`, `server/**` and `ui/**`, which does not cover a file at
the repo root. Add `'middleware.test.ts'` to that `include` array. Run `npx vitest run` and confirm the new
file appears in the run rather than being silently skipped.

- [ ] **Step 6: Commit**

```bash
git add middleware.ts middleware.test.ts vitest.config.ts
git commit -m "Let the operator reach the portal"
```

---

### Task 2: What the page needs to know

A small module that gathers everything the home page shows, so the page itself is arrangement and the
gathering is testable without a browser.

**Files:**
- Create: `app/(portal)/portal/home.ts`
- Test: `app/(portal)/portal/home.test.ts`

**Interfaces:**
- Consumes: `callerFromSession`, `listProjects`, `getHealth`, `readHostd`
- Produces: `type HomeView`, and `gatherHome(deps): Promise<HomeView>`

- [ ] **Step 1: Write the failing test**

Create `app/(portal)/portal/home.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { gatherHome } from './home'

const project = (id: string, state: string) => ({
    id,
    name: id,
    valid: true,
    services: [{ service: `${id}-web`, role: 'site' as const, state, health: null, startedAt: null, restartCount: null, image: null }],
})

function deps(over: Record<string, unknown> = {}) {
    return {
        who: async () => ({ caller: { actor: 'admin', user: 'koda@horizons.gg' }, clientId: null }),
        config: () => ({ ok: true as const, value: { url: 'http://hostd-api:8080', token: 'a'.repeat(32) } }),
        listProjects: async () => ({ ok: true as const, value: [project('asot', 'exited'), project('pmpc', 'running')] }),
        getHealth: async () => ({ ok: true as const, value: { warnings: [], invalid: {}, system: null } }),
        ...over,
    }
}

describe('gatherHome', () => {
    it('reports the operator as the operator, with every site', async () => {
        const view = await gatherHome(deps())
        expect(view.kind).toBe('admin')
        if (view.kind === 'admin') expect(view.sites).toHaveLength(2)
    })

    it('says so when nobody is signed in, rather than pretending', async () => {
        const view = await gatherHome(deps({ who: async () => null }))
        expect(view.kind).toBe('anonymous')
    })

    it('still renders when hostd is unreachable, and says which part failed', async () => {
        // A portal that throws because one service is down is worse than one that tells you it is down
        const view = await gatherHome(deps({
            listProjects: async () => ({ ok: false as const, code: 'unavailable', message: 'hostd is not answering' }),
        }))
        expect(view.kind).toBe('admin')
        if (view.kind === 'admin') {
            expect(view.sites).toEqual([])
            expect(view.trouble).toMatch(/unavailable|not answering/i)
        }
    })

    it('still renders when hostd is not configured at all', async () => {
        const view = await gatherHome(deps({
            config: () => ({ ok: false as const, problems: ['HOSTD_API_TOKEN is not set'] }),
        }))
        expect(view.kind).toBe('admin')
        if (view.kind === 'admin') expect(view.trouble).toMatch(/HOSTD_API_TOKEN/)
    })

    it('never reports the machine to a client, because hostd refuses it anyway', async () => {
        const view = await gatherHome(deps({
            who: async () => ({ caller: { actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' }, clientId: 'cl_8F2K1ABC' }),
        }))
        expect(view.kind).toBe('client')
        expect('health' in view).toBe(false)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/(portal)/portal/home.test.ts"`
Expected: FAIL, cannot resolve `./home`.

- [ ] **Step 3: Write the implementation**

Create `app/(portal)/portal/home.ts`. Note it does **not** import `server-only`: it is a plain module of
logic with every effect injected, and its test runs it directly.

```ts
import type { Project } from '@/server/hostd/projects'

type Ok<T> = { ok: true, value: T }
type Bad = { ok: false, code?: string, message?: string, problems?: string[] }

export type HomeDeps = {
    who: () => Promise<{ caller: { actor: string, user: string }, clientId: string | null } | null>
    config: () => Ok<{ url: string, token: string }> | { ok: false, problems: string[] }
    listProjects: (config: { url: string, token: string }, caller: { actor: string, user: string }) => Promise<Ok<Project[]> | Bad>
    getHealth: (config: { url: string, token: string }, caller: { actor: string, user: string }) => Promise<Ok<unknown> | Bad>
}

export type HomeView =
    | { kind: 'anonymous' }
    | { kind: 'admin', sites: Project[], health: unknown | null, trouble: string | null }
    | { kind: 'client', sites: Project[], trouble: string | null }

function why(result: Bad): string {
    if (result.problems?.length) return result.problems.join('; ')
    return result.message ?? result.code ?? 'hostd did not answer'
}

export async function gatherHome(deps: HomeDeps): Promise<HomeView> {
    const who = await deps.who()
    if (!who) return { kind: 'anonymous' }

    const isAdmin = who.clientId === null

    const config = deps.config()
    if (!config.ok) {
        // A missing setting stops the sites, not the page. The operator is told which setting.
        const trouble = why(config)
        return isAdmin
            ? { kind: 'admin', sites: [], health: null, trouble }
            : { kind: 'client', sites: [], trouble: 'This is temporarily unavailable.' }
    }

    const projects = await deps.listProjects(config.value, who.caller)
    const sites = projects.ok ? projects.value : []
    const trouble = projects.ok ? null : (isAdmin ? why(projects) : 'This is temporarily unavailable.')

    if (!isAdmin) return { kind: 'client', sites, trouble }

    // The machine is the operator's alone: hostd answers a client with admin-only, so asking would only
    // produce a refusal to throw away.
    const health = await deps.getHealth(config.value, who.caller)
    return { kind: 'admin', sites, health: health.ok ? health.value : null, trouble }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/(portal)/portal/home.test.ts"`
Expected: PASS, five tests.

- [ ] **Step 5: Commit**

```bash
git add "app/(portal)/portal/home.ts" "app/(portal)/portal/home.test.ts"
git commit -m "Gather what the portal home shows"
```

---

### Task 3: The shell and the operator's home

**Files:**
- Replace: `app/(portal)/portal/page.tsx` (it is a placeholder whose own comment says it must not prejudge this design)
- Create: `app/(portal)/portal/portal.module.css`

**Interfaces:**
- Consumes: `gatherHome`, `Shell`, `Row`, `StatStrip`, `Meter`, `KeyValue`, `StatusDot`, `Callout`

- [ ] **Step 1: Write the page**

Replace `app/(portal)/portal/page.tsx` entirely:

```tsx
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { Callout } from '@/ui/Callout/Callout'
import { Row } from '@/ui/Row/Row'
import { Shell } from '@/ui/Shell/Shell'
import { StatStrip } from '@/ui/StatStrip/StatStrip'
import { StatusDot } from '@/ui/StatusDot/StatusDot'
import { readHostd } from '@/server/hostd/config'
import { getHealth } from '@/server/hostd/health'
import { listProjects } from '@/server/hostd/projects'
import { callerFromSession } from '@/server/hostd/session'
import { gatherHome } from './home'
import styles from './portal.module.css'

export const metadata: Metadata = { title: 'Portal' }
export const dynamic = 'force-dynamic'

// One project's worst service decides how the whole site reads: a site whose web container is down is
// down, whatever its database is doing.
function stateOf(site: { services?: { state: string }[] }): 'up' | 'down' | 'stopped' {
    const states = (site.services ?? []).map(service => service.state)
    if (!states.length) return 'stopped'
    if (states.some(state => state !== 'running')) return states.some(state => state === 'exited') ? 'down' : 'stopped'
    return 'up'
}

export default async function PortalHome() {
    const view = await gatherHome({
        who: callerFromSession,
        config: () => {
            const problems: string[] = []
            const value = readHostd(process.env, problems)
            return problems.length ? { ok: false, problems } : { ok: true, value }
        },
        listProjects: (config, caller) => listProjects(config, caller),
        getHealth: (config, caller) => getHealth(config, caller),
    })

    if (view.kind === 'anonymous') redirect('/portal/sign-in')

    const isAdmin = view.kind === 'admin'
    const down = view.sites.filter(site => stateOf(site) === 'down')

    const nav = (
        <>
            <a className={styles.nav} href="/portal" aria-current="page">{isAdmin ? 'Dashboard' : 'Overview'}</a>
            <p className={styles.group}>{isAdmin ? 'sites' : 'your site'}</p>
            {view.sites.map(site => (
                <a className={styles.nav} key={site.id} href={`/portal/${site.id}`}>
                    <StatusDot state={stateOf(site)} />
                    <span className={styles.navName}>{site.name ?? site.id}</span>
                </a>
            ))}
        </>
    )

    return (
        <Shell brand="Horizons" nav={nav} rail={<Rail view={view} />}>
            <div className={styles.hello}>
                <h1>{isAdmin ? 'Your sites' : 'Your site'}</h1>
                <p>
                    {down.length
                        ? `${down.length} ${down.length === 1 ? 'site is' : 'sites are'} down.`
                        : 'Everything is up.'}
                </p>
            </div>

            {view.trouble && (
                <Callout tone="warn" title="hostd did not answer">{view.trouble}</Callout>
            )}

            <StatStrip stats={[
                { key: 'sites', value: String(view.sites.length) },
                { key: 'down', value: String(down.length), tone: down.length ? 'crit' : undefined },
            ]} />

            <section className={styles.block}>
                <h2>{isAdmin ? 'Sites' : 'Your site'}</h2>
                {view.sites.length === 0
                    ? <p className={styles.empty}>
                        {view.trouble ? 'Nothing to show while hostd is unreachable.' : 'No sites yet.'}
                      </p>
                    : view.sites.map(site => (
                        <Row
                            key={site.id}
                            tone={stateOf(site) === 'down' ? 'crit' : undefined}
                            lead={<StatusDot state={stateOf(site)} />}
                            title={site.name ?? site.id}
                            sub={site.id}
                            aside={site.valid ? undefined : 'not registered properly'}
                        />
                      ))}
            </section>
        </Shell>
    )
}
```

`Rail` is a small local component in the same file: for the operator it lists the machine's figures with
`Meter` and `KeyValue` from `view.health`, and for a client it is a short `KeyValue` of plain facts. Read
`server/hostd/health.ts` for the exact shape of `system` before writing it, and remember every one of its
figures may be `null` with a reason in `problems`. Render a `null` figure as "not available" rather than as
`0`, which would be a lie.

- [ ] **Step 2: Write the stylesheet**

Create `app/(portal)/portal/portal.module.css`. Keep it small: the components carry their own look, and this
is only the page's own frame.

```css
/* The portal paints its own ground. app/globals.css sets --background to the landing scene's navy and
   Tailwind maps it, so the body's colour is not this page's to change. */
.hello { margin-bottom: 18px; }
.hello h1 { font-size: 21px; letter-spacing: -.02em; margin: 0; }
.hello p { color: var(--ink-2); margin: 6px 0 0; font-size: 13.5px; }

.block { margin-top: 24px; }
.block h2 { font-size: 13px; margin: 0 0 10px; }

.empty { color: var(--ink-3); font-size: 12.5px; }

.nav {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 5px;
    font-size: 12.5px;
    color: var(--ink-3);
    text-decoration: none;
}
.nav:hover { color: var(--ink-2); background: rgba(255, 255, 255, .03); }
.nav[aria-current] { color: var(--ink); background: var(--panel-hi); }
.navName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.group { color: var(--ink-3); font-size: 10.5px; margin: 14px 0 5px; padding: 0 8px; }
```

- [ ] **Step 3: Paint the ground**

In `app/(portal)/layout.tsx`, wrap the children so the portal has its own ground without touching the
landing's. Leave the MUI providers in place: the sign-in, invite, reset and account pages under this layout
are MUI and removing them breaks those pages for no gain here.

Add a `div` with `background: var(--night); min-height: 100%` around `{children}`, styled from a module
beside the layout rather than inline.

- [ ] **Step 4: Check it builds and nothing else broke**

Run: `npx vitest run && npm run build && npm run lint && npx tsc --noEmit`
Expected: all pass. Do not run `npm run wallpaper`; `app/(portal)` is excluded from that export already.

- [ ] **Step 5: Commit**

```bash
git add "app/(portal)"
git commit -m "Make the portal home the real, role-aware dashboard"
```

---

### Task 4: Look at it

**Files:** none

This is the only task that can tell you whether any of it is right, and it needs a real session.

- [ ] **Step 1: Sign in as the operator**

With a `.env` present, run `npm run dev`, sign in at `/admin/sign-in`, then open `/portal`. You should see
the three zones, every registered site in the left rail with its status, and the machine's figures on the
right.

If hostd is not running on this machine, that is the more interesting case: the page must still render, with
the sites list empty and a callout naming what failed. A blank page or a stack trace is a bug.

- [ ] **Step 2: Sign in as a client**

Use a client account. `/portal` should show one site, no machine figures, and no mention of hostd when
something is wrong: a client gets "This is temporarily unavailable."

- [ ] **Step 3: Check the phone**

Narrow the window under 760px. The site list becomes a drawer behind the menu button; the rail drops under
the content rather than disappearing. If the rail vanishes, that is the bug this whole design was built to
avoid and it is in `ui/Shell/Shell.module.css`.

- [ ] **Step 4: Record what you found**

Anything wrong goes in the PR, whether or not you fixed it.

---

## What this plan does not do

**The site page.** `/portal/[id]` is linked from the nav and does not exist yet, so those links 404. It gets
its own plan, which is where the disabled Deploys, Backups and Domains tabs are built, using `aria-disabled`
for the reason given at the top.

**The quote inbox and the clients list.** Still under `/admin`, still MUI. The conversion is its own plan.
The portal's nav does not link to them yet.
