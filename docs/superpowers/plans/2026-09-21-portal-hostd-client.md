# Portal hostd client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the portal a typed, tested way to call hostd, so the portal screens have something to be built on.

**Architecture:** A `server/hostd/` module following the shape of `server/quotes/` and `server/clients/`: side effects behind injected adapters, failures returned rather than thrown, tests beside the code. The actor header is derived from the session by one function and by nothing else. A route handler relays hostd's log stream, because Server-Sent Events cannot come from a server component.

**Tech Stack:** TypeScript, Next.js 15 App Router, vitest, Prisma, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-20-portal-hostd-client-design.md`

## Global Constraints

- **No em dashes** (U+2014) anywhere: code comments are the only exception, per `CLAUDE.md`.
- **House style:** four-space indent, no semicolons, single quotes, named exports.
- Every module under `server/` starts with `import 'server-only'`.
- Injected dependencies are trailing optional parameters with a real default, as in `verifyTurnstile(token, ip, secret, fetchImpl = fetch)`.
- hostd's API lives at `http://hostd-api:8080` on the external Docker network named `hostd`. No port is published on either side.
- hostd requires three headers on every request: `Authorization: Bearer <token>`, `X-Hostd-Actor` (`admin` or `client:<id>`), and `X-Hostd-User`.
- hostd accepts client ids matching `^[A-Za-z0-9_-]{1,64}$` and user ids matching `^[A-Za-z0-9_@.:+-]{1,128}$`. The portal's `cl_` ids and email addresses already fit.
- Tests run with `npx vitest run`. The unit project includes `server/**/*.test.ts`.

---

### Task 1: The settings group

**Files:**
- Modify: `server/env.ts:15` (export the existing `required` helper)
- Create: `server/hostd/config.ts`
- Test: `server/hostd/config.test.ts`

**Interfaces:**
- Consumes: `Env` and `required` from `server/env.ts`
- Produces: `type HostdConfig = { url: string, token: string }` and `readHostd(env: Env, problems: string[]): HostdConfig`

- [ ] **Step 1: Write the failing test**

Create `server/hostd/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { readHostd } from './config'

describe('readHostd', () => {
    it('reads the url and the token', () => {
        const problems: string[] = []
        const config = readHostd({ HOSTD_URL: 'http://hostd-api:8080', HOSTD_API_TOKEN: 'a'.repeat(32) }, problems)
        expect(problems).toEqual([])
        expect(config).toEqual({ url: 'http://hostd-api:8080', token: 'a'.repeat(32) })
    })

    it('collects both missing settings by name, and never prints the token', () => {
        const problems: string[] = []
        readHostd({}, problems)
        expect(problems).toEqual(['HOSTD_URL is not set', 'HOSTD_API_TOKEN is not set'])
    })

    it('refuses a token short enough to be a placeholder', () => {
        const problems: string[] = []
        readHostd({ HOSTD_URL: 'http://hostd-api:8080', HOSTD_API_TOKEN: 'short' }, problems)
        expect(problems).toEqual(['HOSTD_API_TOKEN must be at least 32 characters'])
        expect(problems.join(' ')).not.toContain('short')
    })

    it('refuses a url that is not http', () => {
        const problems: string[] = []
        readHostd({ HOSTD_URL: 'hostd-api:8080', HOSTD_API_TOKEN: 'a'.repeat(32) }, problems)
        expect(problems).toEqual(['HOSTD_URL must be an http or https URL'])
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/hostd/config.test.ts`
Expected: FAIL, cannot resolve `./config`.

- [ ] **Step 3: Export the helper the group needs**

In `server/env.ts`, change line 15 from `function required(` to `export function required(`. Nothing else in that file changes.

- [ ] **Step 4: Write the implementation**

Create `server/hostd/config.ts`:

```ts
// Where hostd is and how to prove we are the portal. Its own group, so a missing hostd setting stops the
// portal pages that need it and leaves the landing page, the quote form and the inbox working.

import 'server-only'

import { required, type Env } from '../env'

export type HostdConfig = {
    url: string
    token: string
}

export function readHostd(env: Env, problems: string[]): HostdConfig {
    const url = required(env, 'HOSTD_URL', problems)
    if (url && !/^https?:\/\//.test(url)) problems.push('HOSTD_URL must be an http or https URL')

    const token = required(env, 'HOSTD_API_TOKEN', problems)
    // hostd refuses to start under 32 characters, so a shorter one here is a placeholder nobody filled in.
    // The length is reported, never the value.
    if (token && token.length < 32) problems.push('HOSTD_API_TOKEN must be at least 32 characters')

    return { url: url.replace(/\/+$/, ''), token }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/hostd/config.test.ts`
Expected: PASS, four tests.

- [ ] **Step 6: Commit**

```bash
git add server/env.ts server/hostd/config.ts server/hostd/config.test.ts
git commit -m "Read hostd's settings as their own group"
```

---

### Task 2: Who is asking

**Files:**
- Create: `server/hostd/actor.ts`
- Test: `server/hostd/actor.test.ts`

**Interfaces:**
- Consumes: `CLIENT_ID_PATTERN` from `server/clients/ids.ts`
- Produces: `type Caller = { actor: string, user: string }`, `callerForAdmin(email: string): Caller`, `callerForClient(clientId: string): Caller`

- [ ] **Step 1: Write the failing test**

Create `server/hostd/actor.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { callerForAdmin, callerForClient } from './actor'

describe('callerForAdmin', () => {
    it('is the literal admin, with the email for the audit log', () => {
        expect(callerForAdmin('koda@horizons.gg')).toEqual({ actor: 'admin', user: 'koda@horizons.gg' })
    })

    it('refuses an email hostd would reject as a user id', () => {
        expect(() => callerForAdmin('koda horizons.gg')).toThrow(/user id/i)
        expect(() => callerForAdmin('')).toThrow(/user id/i)
    })
})

describe('callerForClient', () => {
    it('names the client', () => {
        expect(callerForClient('cl_8F2K1ABC')).toEqual({ actor: 'client:cl_8F2K1ABC', user: 'cl_8F2K1ABC' })
    })

    it('refuses anything that is not one of our client ids', () => {
        // The header is the whole security seam: if a request could shape it, a client could become admin.
        expect(() => callerForClient('admin')).toThrow(/client id/i)
        expect(() => callerForClient('cl_8F2K1ABC extra')).toThrow(/client id/i)
        expect(() => callerForClient('')).toThrow(/client id/i)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/hostd/actor.test.ts`
Expected: FAIL, cannot resolve `./actor`.

- [ ] **Step 3: Write the implementation**

Create `server/hostd/actor.ts`:

```ts
// The only place an actor header is produced. hostd trusts whatever the portal claims about who is asking,
// so nothing that arrived from a browser may reach these values: a caller is built from a session, or not
// at all. Both builders throw rather than returning a bad header, because a wrong actor is a client acting
// as another client.

import 'server-only'

import { CLIENT_ID_PATTERN } from '../clients/ids'

// What hostd accepts in X-Hostd-User, kept in step with hostd/src/shared/formats.ts
const USER_ID = /^[A-Za-z0-9_@.:+-]{1,128}$/

export type Caller = {
    actor: string
    user: string
}

export function callerForAdmin(email: string): Caller {
    if (!USER_ID.test(email)) throw new Error('hostd: the admin email is not a usable user id')
    return { actor: 'admin', user: email }
}

export function callerForClient(clientId: string): Caller {
    if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error('hostd: not one of our client ids')
    return { actor: `client:${clientId}`, user: clientId }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/hostd/actor.test.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Commit**

```bash
git add server/hostd/actor.ts server/hostd/actor.test.ts
git commit -m "Derive hostd's actor header from a session and nothing else"
```

---

### Task 3: The request

**Files:**
- Create: `server/hostd/client.ts`
- Test: `server/hostd/client.test.ts`

**Interfaces:**
- Consumes: `HostdConfig` from `./config`, `Caller` from `./actor`
- Produces: `type HostdResult<T> = { ok: true, value: T } | { ok: false, code: string, message: string }` and `hostdRequest<T>(config: HostdConfig, caller: Caller, path: string, init?: RequestInit, fetchImpl?: typeof fetch): Promise<HostdResult<T>>`

- [ ] **Step 1: Write the failing test**

Create `server/hostd/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { hostdRequest } from './client'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const caller = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(status: number, body: unknown) {
    const calls: { url: string, headers: Record<string, string>, method?: string }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string>, method: init.method })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('hostdRequest', () => {
    it('sends the token and both actor headers', async () => {
        const { fetchImpl, calls } = fakeFetch(200, { projects: [] })
        const result = await hostdRequest(config, caller, '/projects', {}, fetchImpl)
        expect(result).toEqual({ ok: true, value: { projects: [] } })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects')
        expect(calls[0].headers.Authorization).toBe(`Bearer ${'a'.repeat(32)}`)
        expect(calls[0].headers['X-Hostd-Actor']).toBe('admin')
        expect(calls[0].headers['X-Hostd-User']).toBe('koda@horizons.gg')
    })

    it('returns a refusal rather than throwing', async () => {
        const { fetchImpl } = fakeFetch(403, { code: 'forbidden', message: 'project belongs to another client' })
        const result = await hostdRequest(config, caller, '/projects/acme', {}, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'forbidden', message: 'project belongs to another client' })
    })

    it('returns unavailable when hostd cannot be reached', async () => {
        const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
        const result = await hostdRequest(config, caller, '/projects', {}, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'unavailable', message: 'hostd is not answering' })
    })

    it('returns unavailable when hostd answers with something that is not json', async () => {
        const fetchImpl = (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch
        const result = await hostdRequest(config, caller, '/projects', {}, fetchImpl)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('unavailable')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/hostd/client.test.ts`
Expected: FAIL, cannot resolve `./client`.

- [ ] **Step 3: Write the implementation**

Create `server/hostd/client.ts`:

```ts
// One request function, so the headers are built in one place and a caller cannot forget one. Failures are
// returned rather than thrown: hostd being down makes a control unavailable, it does not stop a page
// rendering.

import 'server-only'

import type { Caller } from './actor'
import type { HostdConfig } from './config'

export type HostdResult<T> =
    | { ok: true, value: T }
    | { ok: false, code: string, message: string }

const TIMEOUT_MS = 10_000

export async function hostdRequest<T>(
    config: HostdConfig,
    caller: Caller,
    path: string,
    init: RequestInit = {},
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<T>> {
    let response: Response
    try {
        response = await fetchImpl(`${config.url}${path}`, {
            ...init,
            headers: {
                ...(init.headers as Record<string, string> | undefined),
                Authorization: `Bearer ${config.token}`,
                'X-Hostd-Actor': caller.actor,
                'X-Hostd-User': caller.user,
            },
            cache: 'no-store',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
    } catch {
        // A refused connection, a DNS failure or the timeout above all mean the same thing to a caller.
        return { ok: false, code: 'unavailable', message: 'hostd is not answering' }
    }

    let body: unknown
    try {
        body = await response.json()
    } catch {
        return { ok: false, code: 'unavailable', message: 'hostd answered with something unreadable' }
    }

    if (!response.ok) {
        const refusal = body as { code?: unknown, message?: unknown }
        return {
            ok: false,
            code: typeof refusal.code === 'string' ? refusal.code : 'failed',
            message: typeof refusal.message === 'string' ? refusal.message : `hostd returned ${response.status}`,
        }
    }

    return { ok: true, value: body as T }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/hostd/client.test.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Commit**

```bash
git add server/hostd/client.ts server/hostd/client.test.ts
git commit -m "Send hostd requests through one function that returns rather than throws"
```

---

### Task 4: Translating a refusal

**Files:**
- Create: `server/hostd/errors.ts`
- Test: `server/hostd/errors.test.ts`

**Interfaces:**
- Consumes: `HostdResult` from `./client`
- Produces: `forClient(code: string): string` and `forAdmin(code: string, message: string): string`

- [ ] **Step 1: Write the failing test**

Create `server/hostd/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { forAdmin, forClient } from './errors'

describe('forClient', () => {
    it('says what happened without naming anything on the server', () => {
        expect(forClient('unavailable')).toBe('This is temporarily unavailable. Nothing has changed, and it is being looked at.')
        expect(forClient('forbidden')).toBe('You do not have access to this.')
        expect(forClient('busy')).toBe('Something else is already running on your site. Try again in a moment.')
    })

    it('falls back without echoing an unknown code', () => {
        expect(forClient('some-new-code-hostd-invented')).toBe('Something went wrong. Koda has been told.')
    })

    it('never leaks a path, a project id or a service name', () => {
        // hostd's own messages name these; the client's version must not.
        const leaky = ['/var/www/acme-bakery', 'acme-bakery', 'acme-web']
        for (const code of ['unavailable', 'forbidden', 'busy', 'unknown']) {
            for (const secret of leaky) expect(forClient(code)).not.toContain(secret)
        }
    })
})

describe('forAdmin', () => {
    it('keeps the words hostd used, because the admin is the operator', () => {
        expect(forAdmin('invalid', 'storage media is not a directory')).toBe('invalid: storage media is not a directory')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/hostd/errors.test.ts`
Expected: FAIL, cannot resolve `./errors`.

- [ ] **Step 3: Write the implementation**

Create `server/hostd/errors.ts`:

```ts
// hostd's messages name paths, project ids and services, which is right for the operator and wrong for a
// client. A client gets a fixed sentence chosen by code; the original is logged by the caller.

import 'server-only'

const CLIENT_MESSAGES: Record<string, string> = {
    unavailable: 'This is temporarily unavailable. Nothing has changed, and it is being looked at.',
    forbidden: 'You do not have access to this.',
    busy: 'Something else is already running on your site. Try again in a moment.',
    'not-found': 'This is not set up yet.',
}

export function forClient(code: string): string {
    return CLIENT_MESSAGES[code] ?? 'Something went wrong. Koda has been told.'
}

export function forAdmin(code: string, message: string): string {
    return `${code}: ${message}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/hostd/errors.test.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Commit**

```bash
git add server/hostd/errors.ts server/hostd/errors.test.ts
git commit -m "Translate a hostd refusal per audience"
```

---

### Task 5: Projects, and who may touch them

**Files:**
- Create: `server/hostd/projects.ts`
- Test: `server/hostd/projects.test.ts`

**Interfaces:**
- Consumes: `hostdRequest`, `HostdResult` from `./client`; `Caller` from `./actor`; `HostdConfig` from `./config`
- Produces: `type ServiceStatus`, `type Project`, `listProjects(...)`, `getProject(...)`, `lifecycle(...)`, `assertOwned(...)`

- [ ] **Step 1: Write the failing test**

Create `server/hostd/projects.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { assertOwned, lifecycle, listProjects } from './projects'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(body: unknown) {
    const calls: { url: string, method?: string }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method })
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('listProjects', () => {
    it('asks hostd for the projects this caller can see', async () => {
        const { fetchImpl, calls } = fakeFetch({ projects: [{ id: 'acme-bakery', name: 'Acme Bakery', valid: true }] })
        const result = await listProjects(config, admin, fetchImpl)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value[0].id).toBe('acme-bakery')
        expect(calls[0].url).toBe('http://hostd-api:8080/projects')
    })
})

describe('lifecycle', () => {
    it('posts the action to the project', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        await lifecycle(config, admin, 'acme-bakery', 'restart', fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/restart')
        expect(calls[0].method).toBe('POST')
    })

    it('refuses a project id hostd would not recognise', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true })
        const result = await lifecycle(config, admin, '../../etc', 'restart', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })
})

describe('assertOwned', () => {
    const sites = [{ projectId: 'acme-bakery', clientId: 'cl_8F2K1ABC' }]
    const findSite = async (projectId: string) => sites.find(s => s.projectId === projectId) ?? null

    it('passes when the site belongs to this client', async () => {
        expect(await assertOwned('cl_8F2K1ABC', 'acme-bakery', findSite)).toBe(true)
    })

    it('refuses a site belonging to another client, before hostd is ever asked', async () => {
        expect(await assertOwned('cl_OTHER123', 'acme-bakery', findSite)).toBe(false)
    })

    it('refuses a project the portal has no site row for', async () => {
        expect(await assertOwned('cl_8F2K1ABC', 'never-heard-of-it', findSite)).toBe(false)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/hostd/projects.test.ts`
Expected: FAIL, cannot resolve `./projects`.

- [ ] **Step 3: Write the implementation**

Create `server/hostd/projects.ts`:

```ts
// The calls the screens make. Every project id is checked against hostd's own id grammar before it reaches
// a URL, and a client's ownership is checked here as well as in hostd, because neither check should be the
// only one.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

// Matches hostd's registry id rule, so a bad id is refused before it can be interpolated into a path
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

export type ServiceStatus = {
    service: string
    state: string
    health?: string
    startedAt?: string
    restarts?: number
    image?: string
}

export type Project = {
    id: string
    name: string
    valid: boolean
    reason?: string
    services?: ServiceStatus[]
}

export type SiteRow = { projectId: string, clientId: string }
export type FindSite = (projectId: string) => Promise<SiteRow | null>

export async function listProjects(
    config: HostdConfig,
    caller: Caller,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Project[]>> {
    const result = await hostdRequest<{ projects: Project[] }>(config, caller, '/projects', {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.projects } : result
}

export async function getProject(
    config: HostdConfig,
    caller: Caller,
    id: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<Project>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    return hostdRequest<Project>(config, caller, `/projects/${id}`, {}, fetchImpl)
}

export async function lifecycle(
    config: HostdConfig,
    caller: Caller,
    id: string,
    action: 'start' | 'stop' | 'restart',
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ ok: boolean }>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    return hostdRequest<{ ok: boolean }>(config, caller, `/projects/${id}/${action}`, { method: 'POST' }, fetchImpl)
}

// The portal's own ownership check. hostd runs its own, and describes it as a second line of defence
// against portal bugs; that only works if there is a first line.
export async function assertOwned(clientId: string, projectId: string, findSite: FindSite): Promise<boolean> {
    const site = await findSite(projectId)
    return site !== null && site.clientId === clientId
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/hostd/projects.test.ts`
Expected: PASS, six tests.

- [ ] **Step 5: Commit**

```bash
git add server/hostd/projects.ts server/hostd/projects.test.ts
git commit -m "Add the hostd project calls, with the portal's own ownership check"
```

---

### Task 6: The deployment seam

**Files:**
- Modify: `docker-compose.yml` (add the `networks` section and put `web` on it)
- Modify: `.env.example` (add both variables)

**Interfaces:**
- Consumes: nothing
- Produces: the `hostd` network membership that every call in Tasks 3 to 5 depends on at runtime

- [ ] **Step 1: Add the variables to `.env.example`**

Append to `.env.example`:

```
# hostd, the service that controls client sites. The same token as hostd/.env on the dedi.
HOSTD_URL=http://hostd-api:8080
HOSTD_API_TOKEN=
```

- [ ] **Step 2: Put the web service on hostd's network**

In `docker-compose.yml`, add `networks` to the `web` service and a top-level `networks` section. The network is
marked external because hostd's own compose file creates it: the portal joins the existing one and never
starts or depends on hostd's lifecycle.

```yaml
services:
  web:
    networks: [default, hostd]

networks:
  hostd:
    external: true
    name: hostd
```

- [ ] **Step 3: Check the compose file still parses**

Run: `docker compose config --quiet`
Expected: no output, exit 0. If it reports that the `hostd` network is missing, hostd is not running on this
machine; that is expected on a development machine and the check can be skipped there.

- [ ] **Step 4: Check nothing else broke**

Run: `npm run build && npm run lint && npx tsc --noEmit && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "Put the site on hostd's network"
```

---

## What this plan does not do

No page, component or route handler is built here. The log relay named in the spec waits for the first
screen that streams logs, because a relay with nothing calling it cannot be tested honestly.

The two requests of hostd recorded in the spec, status in the project list and memory, CPU and system disk
in health, belong to hostd and are not in this plan. `listProjects` returns whatever hostd sends, so it
needs no change when the first of those lands.

## Verification on the dedi

From the runbook, once this is deployed: `docker compose exec web node -e` a single `listProjects` call
against the real hostd, with the admin caller, and confirm it returns the registered projects. A `403`
means the token does not match `hostd/.env`; a hang means `web` is not on the `hostd` network.
