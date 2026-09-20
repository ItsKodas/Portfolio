# Portal hostd logs and env Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the portal's hostd client to cover env files and the log stream, and add the route that relays that stream to a browser, so the site page's Logs and Environment tabs have something to be built on.

**Architecture:** Two more modules beside the existing `server/hostd/` ones, following the same shape: injected `fetch`, failures returned rather than thrown. The log relay is split in two, a pure function that can be tested and a thin Next route handler that supplies the real session, because Server-Sent Events cannot come from a server component.

**Tech Stack:** TypeScript, Next.js 15 App Router route handlers, vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-portal-hostd-client-design.md`

## Global Constraints

- **No em dashes** (U+2014) anywhere: code comments are the only exception, per `CLAUDE.md`.
- **House style:** four-space indent, no semicolons, single quotes, named exports.
- Every module under `server/` starts with `import 'server-only'`.
- Injected dependencies are trailing optional parameters with a real default.
- **Touch nothing in `ui/`, `app/globals.css`, `app/layout.tsx`, `vitest.config.ts` or the root `package.json`.** Another session is working in those files. This plan adds files under `server/hostd/` and `app/api/` only, plus no dependencies.
- **Touch nothing in `hostd/`.** A third session is working there.
- Tests run with `npx vitest run`. The unit project already includes `server/**/*.test.ts` and `app/**/*.test.ts`.

## What hostd already offers

Read from the running code, not assumed:

| Endpoint | Shape |
| --- | --- |
| `GET /projects/:id/:env/env` | Lists the env files. `:env` is `live` or `test`. Answers `{ ok: true, files: [{ path, example, bytes }] }`, where `example` is the path of that file's `.example` sibling or `null`. |
| `GET /projects/:id/:env/env/<path>` | One file. Answers `{ ok: true, text }`. |
| `PUT /projects/:id/:env/env/<path>` | Saves one file. The body is **JSON**, `{ "text": "..." }`, and `text` is its only permitted key. Answers `{ ok: true, output }`. |
| `GET /projects/:id/logs?service=&tail=&since=&follow=` | Server-Sent Events. Two event types: `line` carrying one log line, and `end`. Idle streams carry `: keepalive` comments. A dead agent gives `503` with code `agent-unavailable`. |

---

### Task 1: Env files

> **Corrected 2026-09-21.** The first version of this task had hostd's env contract wrong in three places,
> and its tests asserted the wrong contract rather than catching it: a test expecting a raw PUT body would
> have gone green over code hostd answers with a 400. The three are recorded below so the mistake is
> visible rather than quietly patched. Read the shapes in the table above; they were checked against
> `hostd/src/api/routes.ts`, `hostd/src/agent/agent.ts` and `hostd/src/agent/env-files.ts`.
>
> | Was | Is |
> | --- | --- |
> | PUT sends the file contents as a raw body | PUT sends JSON, `{ "text": "..." }`, and `text` is its only permitted key |
> | A read answers `{ contents }` | A read answers `{ ok: true, text }` |
> | A list entry is `{ path, example?: string }` | A list entry is `{ path, example: string \| null, bytes: number }` |

**Files:**
- Create: `server/hostd/env.ts`
- Test: `server/hostd/env.test.ts`

**Interfaces:**
- Consumes: `hostdRequest`, `HostdResult` from `./client`; `Caller` from `./actor`; `HostdConfig` from `./config`
- Produces: `type EnvironmentName = 'live' | 'test'`, `type EnvFile = { path: string, example: string | null, bytes: number }`, `listEnvFiles(...)`, `readEnvFile(...)`, `writeEnvFile(...)`

- [ ] **Step 1: Write the failing test**

Create `server/hostd/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { listEnvFiles, readEnvFile, writeEnvFile } from './env'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string, method?: string, body?: unknown, headers?: Record<string, string> }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: init.body, headers: init.headers as Record<string, string> })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('listEnvFiles', () => {
    it('asks for the environment the caller named, and unwraps the list', async () => {
        const files = [{ path: '.env', example: '.env.example', bytes: 412 }, { path: 'worker/.env', example: null, bytes: 96 }]
        const { fetchImpl, calls } = fakeFetch({ ok: true, files })
        const result = await listEnvFiles(config, admin, 'acme-bakery', 'test', fetchImpl)
        expect(result).toEqual({ ok: true, value: files })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/test/env')
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, files: [] })
        const result = await listEnvFiles(config, admin, '../etc', 'live', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })
})

describe('readEnvFile', () => {
    it('puts the file path after the environment, and returns the text itself', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, text: 'NODE_ENV=production\n' })
        const result = await readEnvFile(config, admin, 'acme-bakery', 'live', 'worker/.env', fetchImpl)
        expect(result).toEqual({ ok: true, value: 'NODE_ENV=production\n' })
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/live/env/worker/.env')
    })

    it('refuses a path that climbs out of the environment', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, text: '' })
        for (const path of ['../.env', 'a/../../b', '/etc/passwd', 'a\\b']) {
            const result = await readEnvFile(config, admin, 'acme-bakery', 'live', path, fetchImpl)
            expect(result, path).toEqual({ ok: false, code: 'bad-request', message: 'not a file inside this environment' })
        }
        expect(calls).toHaveLength(0)
    })
})

describe('writeEnvFile', () => {
    it('sends the contents as JSON under text, which is the only key hostd accepts', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, output: '.env was written' })
        await writeEnvFile(config, admin, 'acme-bakery', 'live', '.env', 'NODE_ENV=production\n', fetchImpl)
        expect(calls[0].method).toBe('PUT')
        expect(calls[0].headers?.['content-type']).toBe('application/json')
        expect(JSON.parse(calls[0].body as string)).toEqual({ text: 'NODE_ENV=production\n' })
    })

    it('refuses the same paths a read refuses', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, output: '' })
        const result = await writeEnvFile(config, admin, 'acme-bakery', 'live', '../.env', 'X=1', fetchImpl)
        expect(result).toEqual({ ok: false, code: 'bad-request', message: 'not a file inside this environment' })
        expect(calls).toHaveLength(0)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/hostd/env.test.ts`
Expected: FAIL, cannot resolve `./env`.

- [ ] **Step 3: Write the implementation**

Create `server/hostd/env.ts`:

```ts
// Env files, per environment. hostd confines writes to env files inside one environment's folder, and
// checks every path itself; this checks first anyway, so a portal bug cannot spend a request asking for
// something it already knows is wrong.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

export type EnvironmentName = 'live' | 'test'

export type EnvFile = {
    path: string
    // The path of this file's .example sibling, or null when it has none
    example: string | null
    bytes: number
}

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

const NO_PROJECT: HostdResult<never> = { ok: false, code: 'not-found', message: 'no such project' }
const BAD_PATH: HostdResult<never> = { ok: false, code: 'bad-request', message: 'not a file inside this environment' }

// Relative, no climbing, no backslashes, no leading slash. hostd resolves the real path one component at
// a time and refuses a symlink at any position; this is only the obvious first pass.
function safePath(path: string): boolean {
    if (!path || path.startsWith('/') || path.includes('\\')) return false
    return !path.split('/').some(segment => segment === '..' || segment === '')
}

export async function listEnvFiles(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<EnvFile[]>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    const result = await hostdRequest<{ files: EnvFile[] }>(config, caller, `/projects/${id}/${environment}/env`, {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.files } : result
}

export async function readEnvFile(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    path: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<string>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (!safePath(path)) return BAD_PATH
    const result = await hostdRequest<{ text: string }>(config, caller, `/projects/${id}/${environment}/env/${path}`, {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.text } : result
}

export async function writeEnvFile(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    path: string,
    text: string,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ output: string }>> {
    if (!PROJECT_ID.test(id)) return NO_PROJECT
    if (!safePath(path)) return BAD_PATH
    // JSON, with text as its only key. hostd reads the body with readJsonBody and then refuses any other
    // key, so a raw body is answered with a 400.
    return hostdRequest<{ output: string }>(
        config,
        caller,
        `/projects/${id}/${environment}/env/${path}`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) },
        fetchImpl,
    )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/hostd/env.test.ts`
Expected: PASS, six tests.

- [ ] **Step 5: Check the contract against hostd itself**

The last version of this task was wrong precisely because it was written from the URL shapes without
reading the handlers. Before committing, open `hostd/src/api/routes.ts` and confirm by eye that
`parseEnvWriteBody` still accepts only `text`, and that the agent's `env` action still answers `files` for
a list and `text` for a read. If any of it has moved, stop and say so rather than adjusting the code to
match a test.

- [ ] **Step 6: Commit**

```bash
git add server/hostd/env.ts server/hostd/env.test.ts
git commit -m "Add the hostd env file calls"
```

---

### Task 2: Opening the log stream

**Files:**
- Create: `server/hostd/logs.ts`
- Test: `server/hostd/logs.test.ts`

**Interfaces:**
- Consumes: `Caller` from `./actor`, `HostdConfig` from `./config`
- Produces: `type LogQuery = { service: string, tail?: number, since?: string, follow?: boolean }` and `openLogStream(config, caller, id, query, fetchImpl?): Promise<{ ok: true, response: Response } | { ok: false, code: string, message: string }>`

This one returns the `Response` rather than parsed JSON, because the body is a stream the route handler
pipes straight through. That is why it does not go through `hostdRequest`.

- [ ] **Step 1: Write the failing test**

Create `server/hostd/logs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { openLogStream } from './logs'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(status: number, body = 'event: line\ndata: {}\n\n') {
    const calls: { url: string, headers: Record<string, string> }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> })
        return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('openLogStream', () => {
    it('builds the query hostd expects and sends the actor headers', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        const result = await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web', tail: 200, follow: true }, fetchImpl)
        expect(result.ok).toBe(true)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/logs?service=acme-web&tail=200&follow=1')
        expect(calls[0].headers['X-Hostd-Actor']).toBe('admin')
    })

    it('passes since through, which is how a reconnect picks up where it left off', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web', since: '2026-09-21T04:10:00Z' }, fetchImpl)
        expect(calls[0].url).toContain('since=2026-09-21T04%3A10%3A00Z')
    })

    it('leaves out what was not asked for', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web' }, fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme-bakery/logs?service=acme-web')
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const { fetchImpl, calls } = fakeFetch(200)
        const result = await openLogStream(config, admin, 'nope!', { service: 'acme-web' }, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'not-found', message: 'no such project' })
        expect(calls).toHaveLength(0)
    })

    it('reports a refusal rather than handing back a broken stream', async () => {
        const { fetchImpl } = fakeFetch(503, JSON.stringify({ code: 'agent-unavailable', message: 'the agent is not answering' }))
        const result = await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web' }, fetchImpl)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('agent-unavailable')
    })

    it('reports unavailable when hostd cannot be reached at all', async () => {
        const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
        const result = await openLogStream(config, admin, 'acme-bakery', { service: 'acme-web' }, fetchImpl)
        expect(result).toEqual({ ok: false, code: 'unavailable', message: 'hostd is not answering' })
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/hostd/logs.test.ts`
Expected: FAIL, cannot resolve `./logs`.

- [ ] **Step 3: Write the implementation**

Create `server/hostd/logs.ts`:

```ts
// Opening hostd's log stream. Unlike every other call this returns the Response itself, because the body
// is a stream the route handler pipes to the browser rather than something to parse. No timeout either:
// a follow stream is meant to stay open, and hostd closes it after an hour.

import 'server-only'

import type { Caller } from './actor'
import type { HostdConfig } from './config'

export type LogQuery = {
    service: string
    tail?: number
    since?: string
    follow?: boolean
}

export type LogStream =
    | { ok: true, response: Response }
    | { ok: false, code: string, message: string }

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

export async function openLogStream(
    config: HostdConfig,
    caller: Caller,
    id: string,
    query: LogQuery,
    fetchImpl: typeof fetch = fetch,
): Promise<LogStream> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }

    const params = new URLSearchParams({ service: query.service })
    if (query.tail !== undefined) params.set('tail', String(query.tail))
    if (query.since) params.set('since', query.since)
    if (query.follow) params.set('follow', '1')

    let response: Response
    try {
        response = await fetchImpl(`${config.url}/projects/${id}/logs?${params}`, {
            headers: {
                Authorization: `Bearer ${config.token}`,
                'X-Hostd-Actor': caller.actor,
                'X-Hostd-User': caller.user,
            },
            cache: 'no-store',
        })
    } catch {
        return { ok: false, code: 'unavailable', message: 'hostd is not answering' }
    }

    if (!response.ok) {
        let refusal: { code?: unknown, message?: unknown } = {}
        try {
            refusal = await response.json() as typeof refusal
        } catch {
            // hostd answered with something that is not a refusal document
        }
        return {
            ok: false,
            code: typeof refusal.code === 'string' ? refusal.code : 'failed',
            message: typeof refusal.message === 'string' ? refusal.message : `hostd returned ${response.status}`,
        }
    }

    return { ok: true, response }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/hostd/logs.test.ts`
Expected: PASS, six tests.

- [ ] **Step 5: Commit**

```bash
git add server/hostd/logs.ts server/hostd/logs.test.ts
git commit -m "Add opening hostd's log stream"
```

---

### Task 3: The relay

**Files:**
- Create: `server/hostd/relay.ts`
- Test: `server/hostd/relay.test.ts`
- Create: `app/api/sites/[id]/logs/route.ts`

**Interfaces:**
- Consumes: `openLogStream`, `LogQuery` from `./logs`; `Caller` from `./actor`; `HostdConfig` from `./config`
- Produces: `relayLogs(deps, id, params): Promise<Response>`

The relay is split from the route handler so it can be tested without a session, a cookie or a running
server. The handler's whole job is to supply the real caller.

- [ ] **Step 1: Write the failing test**

Create `server/hostd/relay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { relayLogs } from './relay'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function deps(open: unknown, owns = true) {
    return {
        config,
        caller: admin,
        clientId: null as string | null,
        assertOwned: async () => owns,
        openLogStream: open as never,
    }
}

describe('relayLogs', () => {
    it('passes the stream through as server-sent events', async () => {
        const body = 'event: line\ndata: {"text":"Ready"}\n\n'
        const open = async () => ({ ok: true, response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
        const response = await relayLogs(deps(open), 'acme-bakery', new URLSearchParams({ service: 'acme-web' }))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.text()).toBe(body)
    })

    it('refuses without a service, since hostd requires one', async () => {
        const open = async () => { throw new Error('should not be called') }
        const response = await relayLogs(deps(open), 'acme-bakery', new URLSearchParams())
        expect(response.status).toBe(400)
    })

    it('refuses a site belonging to another client, before hostd is asked', async () => {
        const open = async () => { throw new Error('should not be called') }
        const withClient = { ...deps(open, false), clientId: 'cl_8F2K1ABC' }
        const response = await relayLogs(withClient, 'acme-bakery', new URLSearchParams({ service: 'acme-web' }))
        expect(response.status).toBe(404)
    })

    it('turns a hostd refusal into a status, without passing its words to the browser', async () => {
        const open = async () => ({ ok: false, code: 'agent-unavailable', message: '/run/hostd/agent.sock is not answering' })
        const response = await relayLogs(deps(open), 'acme-bakery', new URLSearchParams({ service: 'acme-web' }))
        expect(response.status).toBe(503)
        expect(await response.text()).not.toContain('/run/hostd')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/hostd/relay.test.ts`
Expected: FAIL, cannot resolve `./relay`.

- [ ] **Step 3: Write the implementation**

Create `server/hostd/relay.ts`:

```ts
// Relays hostd's log stream to a browser. The browser names a project and a service and nothing else: the
// caller comes from the session, the token never leaves the server, and a client's ownership is checked
// here before hostd is asked.

import 'server-only'

import type { Caller } from './actor'
import type { HostdConfig } from './config'
import { forClient } from './errors'
import type { LogStream } from './logs'

export type RelayDeps = {
    config: HostdConfig
    caller: Caller
    // null when the caller is the operator, who owns everything
    clientId: string | null
    assertOwned: (clientId: string, projectId: string) => Promise<boolean>
    openLogStream: (
        config: HostdConfig,
        caller: Caller,
        id: string,
        query: { service: string, tail?: number, since?: string, follow?: boolean },
    ) => Promise<LogStream>
}

const STATUS: Record<string, number> = {
    'not-found': 404,
    forbidden: 403,
    'bad-request': 400,
    'agent-unavailable': 503,
    unavailable: 503,
}

function problem(code: string): Response {
    return Response.json({ code, message: forClient(code) }, { status: STATUS[code] ?? 500 })
}

export async function relayLogs(deps: RelayDeps, id: string, params: URLSearchParams): Promise<Response> {
    const service = params.get('service')
    if (!service) return problem('bad-request')

    // A client may only watch their own site. Answering 404 rather than 403 means the portal does not
    // confirm that a project id exists to somebody who has no business knowing.
    if (deps.clientId && !(await deps.assertOwned(deps.clientId, id))) return problem('not-found')

    const tailText = params.get('tail')
    const tail = tailText === null ? undefined : Number(tailText)
    if (tail !== undefined && (!Number.isInteger(tail) || tail < 1)) return problem('bad-request')

    const stream = await deps.openLogStream(deps.config, deps.caller, id, {
        service,
        tail,
        since: params.get('since') ?? undefined,
        follow: params.get('follow') === '1',
    })

    if (!stream.ok) return problem(stream.code)

    return new Response(stream.response.body, {
        status: 200,
        headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            // Stops a proxy buffering the stream into uselessness
            'x-accel-buffering': 'no',
        },
    })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/hostd/relay.test.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Write the route handler**

Create `app/api/sites/[id]/logs/route.ts`. This is the thin half: it establishes who is asking and hands
over. Read `server/auth/index.ts` and `server/clients/session.ts` first and use whatever those already
export for reading the admin session and the client session; do not invent a new way to do it.

```ts
import { getDb } from '@/server/db'
import { callerForAdmin, callerForClient } from '@/server/hostd/actor'
import { readHostd } from '@/server/hostd/config'
import { openLogStream } from '@/server/hostd/logs'
import { assertOwned } from '@/server/hostd/projects'
import { relayLogs } from '@/server/hostd/relay'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params

    // Work out who is asking from the session alone. Nothing in the request may influence this.
    const who = await callerFromSession()
    if (!who) return Response.json({ code: 'forbidden', message: 'Sign in first.' }, { status: 403 })

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) {
        console.error('hostd is not configured:', problems.join('; '))
        return Response.json({ code: 'unavailable', message: 'This is temporarily unavailable.' }, { status: 503 })
    }

    const db = getDb()
    return relayLogs(
        {
            config,
            caller: who.caller,
            clientId: who.clientId,
            assertOwned: (clientId, projectId) => assertOwned(clientId, projectId, async pid => {
                const site = await db.site.findUnique({ where: { projectId: pid }, select: { projectId: true, clientId: true } })
                return site
            }),
            openLogStream,
        },
        id,
        new URL(request.url).searchParams,
    )
}
```

`callerFromSession()` is the one piece to write against the existing auth modules: it returns
`{ caller: callerForAdmin(email), clientId: null }` for a signed-in admin,
`{ caller: callerForClient(clientId), clientId }` for a signed-in client, and `null` for neither. Put it in
this file if it is short, or in `server/hostd/session.ts` with its own test if it is not.

- [ ] **Step 6: Check it all builds**

Run: `npx vitest run && npm run build && npm run lint && npx tsc --noEmit`
Expected: all pass. Do not run `npm run wallpaper`: it excludes `app/api` already, and the other session is
changing files it does read.

- [ ] **Step 7: Commit**

```bash
git add server/hostd/relay.ts server/hostd/relay.test.ts "app/api/sites/[id]/logs/route.ts"
git commit -m "Relay hostd's log stream to the browser"
```

---

## What this plan does not do

No page, component or tab. This gives the site page's Logs and Environment tabs something to call, and
stops there.

The env endpoints are operator-only in hostd, so nothing here is reachable by a client. The relay is the
only piece a client can reach, and it checks ownership before hostd is asked.
