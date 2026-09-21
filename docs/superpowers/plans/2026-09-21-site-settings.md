# Site settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can set a site's capabilities, repo and branch from a Settings tab in the portal, including converting a hand-enrolled live-only registry entry to the environments shape.

**Architecture:** One new `configure` change kind in hostd's registry writer does the whole edit in a single validated, atomic write. One new agent verb and one new API route (`PUT /projects/:id/settings`) carry it, admin-only and gated on no capability. The portal reads the current values from the project list, which gains `repo` for the operator, and posts the form through a server action.

**Tech Stack:** hostd (Node 22, `node:test`, `yaml`), portal (Next.js 15 App Router, React 18, vitest, CSS Modules)

**Spec:** `docs/superpowers/specs/2026-09-21-site-settings-design.md`

## Global Constraints

- **No em dashes (U+2014) anywhere**: page copy, UI text, docs, commit messages or PR descriptions. Comments in code are the one exception. Use a comma, colon, full stop or parentheses.
- **Read the source, never the prose.** Every field name, type and refusal code in this plan was copied from the file it lives in, but check it again before you use it. Writing an integration type from a design document rather than from the code it talks to is how this project has shipped green tests over unworkable code more than once.
- hostd tests: `node:test` and `node:assert/strict`, run with `cd hostd && npm test`.
- Portal tests: vitest, run with `npx vitest run`. Projects are `unit` (`app/**/*.test.ts`, `server/**/*.test.ts`, `ui/**/*.test.ts`), `db`, and `dom` (`ui/**/*.test.tsx`, `app/**/*.test.tsx`, jsdom).
- Capabilities, verbatim from `hostd/src/shared/registry.ts:13`: `lifecycle`, `logs`, `files`, `backups`, `domains`, `provision`, `env`, `deploy`.
- Refusal codes, verbatim from `hostd/src/shared/protocol.ts:82`: `bad-request`, `unknown-project`, `invalid-project`, `capability-disabled`, `unknown-service`, `unknown-environment`, `busy`, `failed`, `unavailable`.
- Portal colours come from tokens. `ui/palette.test.ts` walks `ui/` and fails on a literal colour; files under `app/` are not walked, so keep the rule there by hand.

---

## File Structure

**hostd**

| File | Responsibility |
| --- | --- |
| `hostd/src/shared/registry-write.ts` | Gains the `configure` change kind and the live-only conversion. The only code that writes the registry. |
| `hostd/src/shared/registry-write.test.ts` | The heaviest coverage in this plan: this is the only thing here that can corrupt the registry. |
| `hostd/src/shared/protocol.ts` | Gains `ConfigureRequest`, its args type, and `VERB_CAPABILITY.configure = null`. |
| `hostd/src/agent/agent.ts` | Gains the `configure` case, after the same `checkStructure` every project verb runs. |
| `hostd/src/api/policy.ts` | `PolicyVerb` gains `configure`; `POLICY_CAPABILITY.configure = null`; `ADMIN_ONLY` gains it. |
| `hostd/src/api/routes.ts` | Gains the `settings` route, `parseSettingsBody`, the switch case, and `repo` on a list entry. |

**portal**

| File | Responsibility |
| --- | --- |
| `server/hostd/settings.ts` | The one call, `writeSettings`. Mirrors `server/hostd/env.ts`. |
| `server/hostd/projects.ts` | `Project` gains `repo?: string \| null`. |
| `app/(portal)/portal/sites/[id]/settings.tsx` | The tab's form, a client component. |
| `app/(portal)/portal/sites/[id]/actions.ts` | Gains `saveSettingsAction`, behind the same admin gate `saveEnvAction` uses. |
| `app/(portal)/portal/sites/[id]/page.tsx` | The tab, and the Environment tab's new disabled state. |
| `app/(portal)/portal/sites/[id]/site.module.css` | The form's own frame. |
| `hostd/RUNBOOK.md` | Says the portal is where this is done now, and what still is not. |

---

### Task 1: The `configure` change kind and the conversion

The whole registry write. Everything else in this plan is a pipe that carries it.

**Files:**
- Modify: `hostd/src/shared/registry-write.ts`
- Test: `hostd/src/shared/registry-write.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `Change` gains
  ```ts
  | {
      kind: 'configure'
      id: string
      capabilities?: Capability[]
      repo?: string | null
      branches?: Partial<Record<EnvironmentName, string | null>>
  }
  ```
  `Capability` and `EnvironmentName` both come from `./registry.ts`, which `registry-write.ts` already imports from. Check whether `Capability` is among the existing type imports and add it if not.

- [ ] **Step 1: Write the failing tests**

The existing file has a `BASE` fixture with an environments-shaped project. Add a second fixture beside it for the live-only shape, spelled the way the real entries are:

```ts
const LIVE_ONLY = `reserved: [horizons.gg]
projects:
  arbysauto:
    client: cl_1
    name: Arbys Auto Glass
    # the operator's own note, which must survive a write
    dir: /var/www/arbysauto
    compose: [docker-compose.yml, docker-compose.override.yml]
    upstream: 127.0.0.1:5011
    services:
      web: { role: site }
    capabilities: [lifecycle, logs]
`
```

```ts
describe('configure', () => {
    it('replaces the capability list wholesale', () => {
        const result = applyChange(LIVE_ONLY, { kind: 'configure', id: 'arbysauto', capabilities: ['lifecycle', 'logs', 'env', 'deploy'] })
        assert.ok(result.ok)
        const registry = parseRegistry(result.text)
        assert.deepEqual([...registry.projects.get('arbysauto')!.capabilities], ['lifecycle', 'logs', 'env', 'deploy'])
    })

    it('can take every capability away', () => {
        const result = applyChange(LIVE_ONLY, { kind: 'configure', id: 'arbysauto', capabilities: [] })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('arbysauto')!.capabilities.size, 0)
    })

    it('writes the capability list in flow style, the way the file already writes it', () => {
        // A block sequence would validate and would reformat a file a person maintains by hand
        const result = applyChange(LIVE_ONLY, { kind: 'configure', id: 'arbysauto', capabilities: ['lifecycle', 'env'] })
        assert.ok(result.ok)
        assert.match(result.text, /capabilities: \[lifecycle, env\]/)
    })

    it('sets a repo, and clears one', () => {
        const set = applyChange(LIVE_ONLY, { kind: 'configure', id: 'arbysauto', repo: 'git@github.com:ItsKodas/arbysauto.git' })
        assert.ok(set.ok)
        assert.equal(parseRegistry(set.text).projects.get('arbysauto')!.repo, 'git@github.com:ItsKodas/arbysauto.git')

        const cleared = applyChange(set.text, { kind: 'configure', id: 'arbysauto', repo: null })
        assert.ok(cleared.ok)
        assert.equal(parseRegistry(cleared.text).projects.get('arbysauto')!.repo, null)
    })

    it('converts a live-only entry when a branch is set on it', () => {
        const result = applyChange(LIVE_ONLY, {
            kind: 'configure',
            id: 'arbysauto',
            repo: 'git@github.com:ItsKodas/arbysauto.git',
            branches: { live: 'main' },
        })
        assert.ok(result.ok)

        const live = parseRegistry(result.text).projects.get('arbysauto')!.environments.get('live')!
        assert.equal(live.dir, '/var/www/arbysauto')
        assert.equal(live.branch, 'main')
        assert.equal(live.port, 5011)
        // Every compose file, in the order it was written: an unnamed override is an override hostd
        // cannot see, and the order is the order compose merges them
        assert.deepEqual(live.composePaths, ['/var/www/arbysauto/docker-compose.yml', '/var/www/arbysauto/docker-compose.override.yml'])

        // The three keys the registry refuses to hold beside environments are gone
        assert.doesNotMatch(result.text, /^\s+dir:/m)
        assert.doesNotMatch(result.text, /upstream:/)
        // and the operator's note is still there
        assert.match(result.text, /the operator's own note/)
    })

    it('carries the default compose across when the entry named none', () => {
        const bare = LIVE_ONLY.replace('    compose: [docker-compose.yml, docker-compose.override.yml]\n', '')
        const result = applyChange(bare, { kind: 'configure', id: 'arbysauto', repo: 'git@github.com:ItsKodas/a.git', branches: { live: 'main' } })
        assert.ok(result.ok)
        const live = parseRegistry(result.text).projects.get('arbysauto')!.environments.get('live')!
        assert.deepEqual(live.composePaths, ['/var/www/arbysauto/docker-compose.yml'])
    })

    it('refuses to convert an entry with no upstream to take a port from', () => {
        const bare = LIVE_ONLY.replace('    upstream: 127.0.0.1:5011\n', '')
        const result = applyChange(bare, { kind: 'configure', id: 'arbysauto', repo: 'git@github.com:ItsKodas/a.git', branches: { live: 'main' } })
        assert.equal(result.ok, false)
        assert.match(result.problem, /upstream/)
    })

    it('leaves an entry that already has environments alone', () => {
        // BASE is the environments-shaped fixture; no conversion, just the branch
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', branches: { live: 'develop' } })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')!.environments.get('live')!.branch, 'develop')
    })

    it('refuses a branch for an environment the entry does not have', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', branches: { test: 'develop' } })
        assert.equal(result.ok, false)
        assert.match(result.problem, /no test environment/)
    })

    it('clears a branch, which is how an environment stops deploying', () => {
        const set = applyChange(BASE, { kind: 'configure', id: 'acme', branches: { live: 'main' } })
        assert.ok(set.ok)
        const cleared = applyChange(set.text, { kind: 'configure', id: 'acme', branches: { live: null } })
        assert.ok(cleared.ok)
        assert.equal(parseRegistry(cleared.text).projects.get('acme')!.environments.get('live')!.branch, null)
    })

    it('refuses a project that is not registered', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'nothing', capabilities: [] })
        assert.equal(result.ok, false)
    })

    // The validator is the one rule about what a field may be. These prove the write never lands.
    it('refuses an unknown capability', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', capabilities: ['lifecycle', 'teleport'] as never })
        assert.equal(result.ok, false)
    })

    it('refuses a repo that is not a git URL', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', repo: 'not a url' })
        assert.equal(result.ok, false)
    })

    it('refuses a branch name that is not a plain one', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', branches: { live: '--upload-pack=evil' } })
        assert.equal(result.ok, false)
    })

    it('refuses a branch on a project with no repo to fetch it from', () => {
        // parseRegistry's own rule: `branch needs repo`
        const noRepo = LIVE_ONLY
        const result = applyChange(noRepo, { kind: 'configure', id: 'arbysauto', branches: { live: 'main' } })
        assert.equal(result.ok, false)
        assert.match(result.problem, /repo/)
    })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd hostd && npm test
```

Expected: the `configure` cases fail. TypeScript will also reject `kind: 'configure'` until the union has it, which is the first thing to fix.

- [ ] **Step 3: Add the change kind and the edit case**

In the `Change` union, after `set-branch`:

```ts
    // One kind rather than three, because a write takes one Change: three would be three reads, three
    // validations, three files on disk and a half-applied save if the second failed. Absent fields are
    // left alone; a null repo or branch deletes that key.
    | {
        kind: 'configure'
        id: string
        capabilities?: Capability[]
        repo?: string | null
        branches?: Partial<Record<EnvironmentName, string | null>>
    }
```

In `edit()`, after the `set-branch` case:

```ts
        case 'configure': {
            if (!has(change.id)) return { problem: `${change.id} is not registered` }

            const branches = Object.entries(change.branches ?? {})
            // A branch has nowhere to go on an entry written the live-only way, so the shape comes first
            if (branches.length > 0 && !doc.hasIn(['projects', change.id, 'environments'])) {
                const converted = toEnvironments(doc, change.id)
                if (converted) return converted
            }

            // Flow style, because that is how the file writes it by hand and a write should not
            // reformat a file a person maintains.
            if (change.capabilities) {
                const node = doc.createNode(change.capabilities)
                node.flow = true
                doc.setIn(['projects', change.id, 'capabilities'], node)
            }

            if (change.repo !== undefined) {
                if (change.repo === null) doc.deleteIn(['projects', change.id, 'repo'])
                else doc.setIn(['projects', change.id, 'repo'], change.repo)
            }

            for (const [name, branch] of branches) {
                const path = ['projects', change.id, 'environments', name]
                if (!doc.hasIn(path)) return { problem: `${change.id} has no ${name} environment` }
                if (branch === null) doc.deleteIn([...path, 'branch'])
                else doc.setIn([...path, 'branch'], branch)
            }

            // No grammar checked here on purpose: applyChange re-parses the whole document with
            // parseRegistry below, which is the one place that decides what a capability, a repo and a
            // branch may be. Two copies of that rule would drift.
            return null
        }
```

- [ ] **Step 4: Add the conversion**

Above `edit()`:

```ts
// A project written the live-only way keeps dir, compose and upstream at the top level and has no
// environments node at all, so there is nothing for a branch to be set on: set-branch answers
// "<id> has no live environment" and always did. This reshapes the entry into the one live environment
// parseRegistry already synthesises for it, which is the same site described the other way round.
//
// upstream's host is not carried anywhere. There is no per-environment host field, and parseRegistry
// answers 127.0.0.1 for an environments-shaped entry, so an entry whose upstream host was something else
// is changed by this rather than merely reshaped. Every real entry uses the loopback address.
function toEnvironments(doc: Document, id: string): EditResult {
    const dir = doc.getIn(['projects', id, 'dir'])
    if (typeof dir !== 'string') return { problem: `${id} has no dir to make an environment from` }

    const upstream = doc.getIn(['projects', id, 'upstream'])
    if (typeof upstream !== 'string') return { problem: `${id} has no upstream to take a port from` }
    // Only the number is read here. Whether it is a usable port is parseRegistry's to say, below.
    const port = Number(upstream.slice(upstream.lastIndexOf(':') + 1))

    const live: Record<string, unknown> = { dir }
    // compose is one file or several, and both spellings are carried across as they were written
    const compose = doc.getIn(['projects', id, 'compose'])
    if (compose !== undefined && compose !== null) {
        live.compose = typeof compose === 'object' && 'toJSON' in compose
            ? (compose as { toJSON: () => unknown }).toJSON()
            : compose
    }
    live.port = port

    doc.setIn(['projects', id, 'environments'], { live })
    doc.deleteIn(['projects', id, 'dir'])
    doc.deleteIn(['projects', id, 'compose'])
    doc.deleteIn(['projects', id, 'upstream'])
    return null
}
```

`Document` is already imported as a type in this file. `doc.createNode` exists on it; if the installed `yaml` version disagrees with either that or `getIn`'s unwrapping, the compose tests in Step 1 are what will tell you, and they are the two that cover both a scalar and a list. Do not work around a surprise here by reformatting the file: report it.

- [ ] **Step 5: Run the tests**

```bash
cd hostd && npm test && npm run typecheck
```

Expected: PASS. If `capabilities: []` produces `capabilities: []` and `parseRegistry` refuses it, read `parseCapabilities` (`hostd/src/shared/registry.ts:290`) and say what it actually does rather than changing the test to match.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/shared/registry-write.ts hostd/src/shared/registry-write.test.ts
git commit -m "Teach the registry writer to configure a project"
```

---

### Task 2: The agent verb

**Files:**
- Modify: `hostd/src/shared/protocol.ts`
- Modify: `hostd/src/agent/agent.ts`
- Test: `hostd/src/agent/agent.test.ts`

**Interfaces:**
- Consumes: the `configure` `Change` from Task 1.
- Produces:
  ```ts
  export type ConfigureArgs = {
      capabilities?: Capability[]
      repo?: string | null
      branches?: Partial<Record<EnvironmentName, string | null>>
  }
  export type ConfigureRequest = { verb: 'configure', project: string, args: ConfigureArgs }
  ```
  and a reply of `{ ok: true }` shape. Check what the existing provision remove answers with (`hostd/src/agent/provision.ts:398`) and follow it rather than inventing a new reply type.

- [ ] **Step 1: Write the failing test**

In `hostd/src/agent/agent.test.ts`, following the shape the file already uses for `provision`:

```ts
it('writes what it was given and says so', async () => {
    const written: Change[] = []
    const agent = makeAgent({ writer: { write: async (change: Change) => { written.push(change); return { ok: true as const } } } })

    const reply = await agent.handle({
        verb: 'configure',
        project: 'acme',
        args: { capabilities: ['lifecycle', 'logs'], repo: null, branches: { live: 'main' } },
    })

    assert.ok(reply.ok)
    assert.deepEqual(written, [{
        kind: 'configure', id: 'acme', capabilities: ['lifecycle', 'logs'], repo: null, branches: { live: 'main' },
    }])
})

it('passes the writer's own refusal back rather than a general one', async () => {
    const agent = makeAgent({ writer: { write: async () => ({ ok: false as const, problem: 'acme has no test environment' }) } })
    const reply = await agent.handle({ verb: 'configure', project: 'acme', args: { branches: { test: 'x' } } })
    assert.equal(reply.ok, false)
    assert.match((reply as Refusal).message, /no test environment/)
})

it('refuses a project the registry could not parse, like every other verb', async () => {
    // checkStructure runs first: an entry parseRegistry rejected is not in registry.projects at all
    const agent = makeAgent({ guardInvalid: new Map([['acme', 'dir must be /var/www/<one segment>']]) })
    const reply = await agent.handle({ verb: 'configure', project: 'acme', args: { capabilities: [] } })
    assert.equal(reply.ok, false)
})
```

Read the file's existing helpers before writing this: it has its own `makeAgent`-equivalent and its own way of standing in for the writer and the registry. Use those. The three assertions above are what must be true; the scaffolding around them is the file's.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd hostd && npm test -- --test-name-pattern=configure
```

- [ ] **Step 3: Add the request type**

In `hostd/src/shared/protocol.ts`, beside the other request types:

```ts
// Editing the registry entry itself: capabilities, repo and each environment's branch. Absent fields are
// left alone, and a null repo or branch clears that key.
export type ConfigureArgs = {
    capabilities?: Capability[]
    repo?: string | null
    branches?: Partial<Record<EnvironmentName, string | null>>
}
export type ConfigureRequest = { verb: 'configure', project: string, args: ConfigureArgs }
```

Add `ConfigureRequest` to the `AgentRequest` union. `Verb` is `AgentRequest['verb']`, so it follows.

In `VERB_CAPABILITY`, with the reason:

```ts
    // Null, and this is load bearing. Gating the verb that edits capabilities on a capability would mean
    // a project with none could never be given any, which is exactly the project that needs this. What
    // guards it is api's policy, where it is admin-only.
    configure: null,
```

- [ ] **Step 4: Add the agent case**

In `agent.ts`'s `handle`, inside the switch that runs after `checkStructure`, following the shape of the `env` case:

```ts
            case 'configure':
                return reply(await this.configure(checked.project, request.args))
```

and the method:

```ts
    private async configure(project: ProjectEntry, args: ConfigureArgs): Promise<AgentReply> {
        const written = await this.deps.writer.write({
            kind: 'configure',
            id: project.id,
            ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities }),
            ...(args.repo === undefined ? {} : { repo: args.repo }),
            ...(args.branches === undefined ? {} : { branches: args.branches }),
        })
        // The writer's problem is the registry validator's own words, which is what the operator needs
        if (!written.ok) return refuse('failed', written.problem)
        this.deps.log(`configure ${project.id}: registry updated`)
        return { ok: true }
    }
```

Check `AgentReply`'s members before returning `{ ok: true }`: if nothing in the union matches, add the smallest reply type that does rather than widening the union loosely.

- [ ] **Step 5: Run the tests**

```bash
cd hostd && npm test && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add hostd/src/shared/protocol.ts hostd/src/agent/agent.ts hostd/src/agent/agent.test.ts
git commit -m "Carry a configure request to the agent"
```

---

### Task 3: The route, the body parser and the policy

**Files:**
- Modify: `hostd/src/api/policy.ts`
- Modify: `hostd/src/api/routes.ts`
- Test: `hostd/src/api/policy.test.ts`, `hostd/src/api/routes.test.ts`

**Interfaces:**
- Consumes: `ConfigureArgs` from Task 2.
- Produces: `PUT /projects/:id/settings`, body `{ capabilities?, repo?, branches? }`, answering the agent's reply or a refusal.

- [ ] **Step 1: Write the failing tests**

```ts
// policy.test.ts
it('refuses a client the configure verb outright, whatever the registry says', () => {
    const decision = authorize(registry, { kind: 'client', client: 'cl_1' }, 'acme', 'configure')
    assert.equal(decision.ok, false)
})

it('lets the admin configure a project with no capabilities at all', () => {
    // The point of the null capability: a project with nothing enabled is exactly the one that needs it
    const decision = authorize(registryWithNoCapabilities, { kind: 'admin' }, 'acme', 'configure')
    assert.equal(decision.ok, true)
})
```

```ts
// routes.test.ts
it('routes a settings write', () => {
    assert.deepEqual(parseRoute('PUT', '/projects/acme/settings'), { verb: 'settings', project: 'acme' })
})

it('allows only PUT there', () => {
    assert.equal(parseRoute('GET', '/projects/acme/settings').verb, 'method-not-allowed')
})

```

Then, through whatever the file already uses to call the server, five more. Each names the exact thing
it must hold:

- A body carrying `{ nonsense: 1 }` is answered 400, and the agent is never called.
- A body whose `capabilities` is `'lifecycle'` rather than `['lifecycle']` is answered 400.
- A body whose `branches` is `{ staging: 'main' }` is answered 400, naming `staging`: `ENVIRONMENTS` is
  the list of what an environment may be called.
- A body carrying all three fields reaches the agent as `{ verb: 'configure', project, args }` with the
  same three values, `repo: null` included rather than dropped.
- A client is answered 403 and the agent is never called, because `configure` is in `ADMIN_ONLY`.

Read `routes.test.ts` first: it has an established way of standing up the server and calling it, and of
asserting what reached the agent. Use that rather than calling `parseRoute` directly if that is what the
file does.

- [ ] **Step 2: Run and watch fail**

```bash
cd hostd && npm test
```

- [ ] **Step 3: Policy**

```ts
export type PolicyVerb = 'status' | 'lifecycle' | 'logs' | 'audit' | 'provision' | 'env' | 'deploy' | 'deploy-read' | 'configure'
```

```ts
const POLICY_CAPABILITY: Record<PolicyVerb, Capability | null> = {
    // ...
    // Null on purpose: see VERB_CAPABILITY in protocol.ts. A project with no capabilities is the one
    // that most needs to be given some.
    configure: null,
}

const ADMIN_ONLY: PolicyVerb[] = ['provision', 'env', 'deploy', 'configure']
```

- [ ] **Step 4: The route**

In the `parts.length === 3` block, beside the other segments:

```ts
        if (segment === 'settings') return only('PUT', { verb: 'settings', project })
```

Add `| { verb: 'settings', project: string }` to the `Route` union.

The body parser, beside `parseEnvWriteBody`:

```ts
// Shapes only. What a capability, a repo and a branch may actually be is the registry validator's, which
// runs on the result of the write; this refuses a body the agent could not read.
function parseSettingsBody(value: Record<string, unknown>): { ok: true, args: ConfigureArgs } | { ok: false, message: string } {
    if (!onlyKeys(value, ['capabilities', 'repo', 'branches'])) {
        return { ok: false, message: 'settings takes only capabilities, repo and branches' }
    }

    const args: ConfigureArgs = {}

    if (value.capabilities !== undefined) {
        if (!Array.isArray(value.capabilities) || value.capabilities.some(item => typeof item !== 'string')) {
            return { ok: false, message: 'capabilities must be a list of strings' }
        }
        args.capabilities = value.capabilities as Capability[]
    }

    if (value.repo !== undefined) {
        if (value.repo !== null && typeof value.repo !== 'string') return { ok: false, message: 'repo must be a string or null' }
        args.repo = value.repo
    }

    if (value.branches !== undefined) {
        const raw = value.branches
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            return { ok: false, message: 'branches must be a mapping of environment names' }
        }
        const branches: Partial<Record<EnvironmentName, string | null>> = {}
        for (const [name, branch] of Object.entries(raw as Record<string, unknown>)) {
            if (!(ENVIRONMENTS as readonly string[]).includes(name)) return { ok: false, message: `${name} is not a known environment` }
            if (branch !== null && typeof branch !== 'string') return { ok: false, message: `branches.${name} must be a string or null` }
            branches[name as EnvironmentName] = branch
        }
        args.branches = branches
    }

    return { ok: true, args }
}
```

The switch case, modelled on the `branch` case at `routes.ts:670`:

```ts
            case 'settings': {
                const target = 'settings'
                const entry = await authorizeProject(route.project, 'configure', target)
                if (!entry) return

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, route.project, 'configure', target)
                const parsed = parseSettingsBody(body.value)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, route.project, 'configure', target)

                const reply = await callAgentAudited({ verb: 'configure', project: route.project, args: parsed.args }, route.project, 'configure', target)
                if (!reply) return
                return respondAgentAction('configure', reply, route.project, target)
            }
```

`respondAgentAction`'s first parameter is typed `'provision' | 'env' | 'deploy'`; widen it to include `'configure'`. Read what it does with that value before assuming it is only a label.

- [ ] **Step 5: Run the tests**

```bash
cd hostd && npm test && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add hostd/src/api
git commit -m "Answer a settings write over the API, admin only"
```

---

### Task 4: `repo` on the project list

The form has to show the repo it edits, and nothing answers it today.

**Files:**
- Modify: `hostd/src/api/routes.ts` (the `list` case)
- Modify: `server/hostd/projects.ts`
- Test: `hostd/src/api/routes.test.ts`, `server/hostd/projects.test.ts`

**Interfaces:**
- Produces: a list entry gains `repo: string | null`, for `actor.kind === 'admin'` only. `Project` in `server/hostd/projects.ts` gains `repo?: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// hostd routes.test.ts
it('answers the operator a project's repo', async () => { /* expect repo on the entry */ })
it('tells a client nothing about the repo', async () => { /* expect the key absent, not null */ })
```

```ts
// server/hostd/projects.test.ts, beside the existing listProjects tests
it('carries a project's repo back for the operator', async () => {
    const fetchImpl = stub({ ok: true, projects: [{ id: 'acme', name: 'Acme', valid: true, repo: 'git@github.com:ItsKodas/acme.git', environments: [] }] })
    const result = await listProjects(config, caller, fetchImpl)
    assert(result.ok && result.value[0].repo === 'git@github.com:ItsKodas/acme.git')
})
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Add it**

In the `list` case's entry builder, beside `capabilities`:

```ts
                        // The operator sees the entry as it is: they own the machine. A client has no use
                        // for the URL of a repository they cannot reach, and it is the kind of detail that
                        // belongs to the machine rather than to their site, so it is absent rather than
                        // null, exactly as environmentsFor withholds dir, composePaths and port.
                        ...(caller.actor.kind === 'admin' ? { repo: project.repo } : {}),
```

In `server/hostd/projects.ts`'s `Project`:

```ts
    // Answered for the operator alone, so it is absent for a client rather than null
    repo?: string | null
```

- [ ] **Step 4: Run both suites**

```bash
cd hostd && npm test && cd .. && npx vitest run --project unit server/hostd
```

- [ ] **Step 5: Commit**

```bash
git add hostd/src/api/routes.ts hostd/src/api/routes.test.ts server/hostd/projects.ts server/hostd/projects.test.ts
git commit -m "Answer the operator a project's repo on the list"
```

---

### Task 5: The portal's call

**Files:**
- Create: `server/hostd/settings.ts`
- Create: `server/hostd/settings.test.ts`

**Interfaces:**
- Consumes: `PUT /projects/:id/settings` from Task 3.
- Produces:
  ```ts
  export type SiteSettings = {
      capabilities?: string[]
      repo?: string | null
      branches?: Record<string, string | null>
  }
  export function writeSettings(config: HostdConfig, caller: Caller, id: string, settings: SiteSettings, fetchImpl?: typeof fetch): Promise<HostdResult<{ ok: boolean }>>
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'

import { writeSettings } from './settings'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const caller = { actor: 'admin', user: 'koda@horizons.gg' }

describe('writeSettings', () => {
    it('puts the settings as JSON', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))

        await writeSettings(config, caller, 'acme', { capabilities: ['lifecycle'], branches: { live: 'main' } }, fetchImpl as unknown as typeof fetch)

        const [url, init] = fetchImpl.mock.calls[0]
        expect(url).toBe('http://hostd-api:8080/projects/acme/settings')
        expect(init.method).toBe('PUT')
        expect(JSON.parse(init.body)).toEqual({ capabilities: ['lifecycle'], branches: { live: 'main' } })
    })

    it('refuses a project id hostd would not recognise, before asking', async () => {
        const fetchImpl = vi.fn()
        const result = await writeSettings(config, caller, 'Not An Id', {}, fetchImpl as unknown as typeof fetch)
        expect(result.ok).toBe(false)
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})
```

Read `server/hostd/env.test.ts` first and match how it stands in for fetch.

- [ ] **Step 2: Run and watch fail**

```bash
npx vitest run --project unit server/hostd/settings.test.ts
```

- [ ] **Step 3: Write the module**

```ts
// The registry entry's own editable fields. hostd checks everything here again, and the registry
// validator has the final say on what a capability, a repo and a branch may be; this checks the project
// id first so a portal bug cannot spend a request asking for something it already knows is wrong.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

export type SiteSettings = {
    capabilities?: string[]
    repo?: string | null
    branches?: Record<string, string | null>
}

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

export async function writeSettings(
    config: HostdConfig,
    caller: Caller,
    id: string,
    settings: SiteSettings,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ ok: boolean }>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    return hostdRequest<{ ok: boolean }>(
        config,
        caller,
        `/projects/${id}/settings`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) },
        fetchImpl,
    )
}
```

- [ ] **Step 4: Run it**

- [ ] **Step 5: Commit**

```bash
git add server/hostd/settings.ts server/hostd/settings.test.ts
git commit -m "Add the portal's settings call"
```

---

### Task 6: The Settings form and its action

**Files:**
- Create: `app/(portal)/portal/sites/[id]/settings.tsx`
- Create: `app/(portal)/portal/sites/[id]/settings.test.tsx`
- Modify: `app/(portal)/portal/sites/[id]/actions.ts`
- Modify: `app/(portal)/portal/sites/[id]/site.module.css`

**Interfaces:**
- Consumes: `writeSettings` and `SiteSettings` from Task 5; `allow(id, true)` and `SiteActionResult` already in `actions.ts`.
- Produces:
  ```ts
  export async function saveSettingsAction(id: string, settings: SiteSettings): Promise<SiteActionResult>
  export function SiteSettingsForm({ id, capabilities, repo, environments }: {
      id: string
      capabilities: string[]
      repo: string | null
      environments: Array<{ name: string, branch: string | null, dir?: string, port?: number }>
  }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveSettingsAction = vi.fn()
const refresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh() }) }))
vi.mock('./actions', () => ({ saveSettingsAction: (...args: unknown[]) => saveSettingsAction(...args) }))

const { SiteSettingsForm } = await import('./settings')

const props = {
    id: 'arbysauto',
    capabilities: ['lifecycle', 'logs'],
    repo: null,
    environments: [{ name: 'live', branch: null, dir: '/var/www/arbysauto', port: 5011 }],
}

beforeEach(() => {
    vi.clearAllMocks()
    saveSettingsAction.mockResolvedValue({ ok: true, message: 'Saved.' })
})

describe('the settings form', () => {
    it('shows every capability, ticked as the registry has it', () => {
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByRole('checkbox', { name: /lifecycle/ })).toBeChecked()
        expect(screen.getByRole('checkbox', { name: /deploy/ })).not.toBeChecked()
        // All eight, including the four hostd cannot act on yet
        expect(screen.getAllByRole('checkbox')).toHaveLength(8)
    })

    it('marks the ones hostd cannot act on yet, so ticking one is not mistaken for switching it on', () => {
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByText(/not built yet/i)).toBeInTheDocument()
    })

    it('sends what was changed, and nothing else', async () => {
        render(<SiteSettingsForm {...props} />)

        await userEvent.click(screen.getByRole('checkbox', { name: /deploy/ }))
        await userEvent.type(screen.getByLabelText(/repo/i), 'git@github.com:ItsKodas/arbysauto.git')
        await userEvent.type(screen.getByLabelText(/branch/i), 'main')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', {
            capabilities: ['lifecycle', 'logs', 'deploy'],
            repo: 'git@github.com:ItsKodas/arbysauto.git',
            branches: { live: 'main' },
        })
    })

    it('sends a cleared repo as null rather than an empty string', async () => {
        render(<SiteSettingsForm {...props} repo="git@github.com:ItsKodas/a.git" />)
        await userEvent.clear(screen.getByLabelText(/repo/i))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))
        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', expect.objectContaining({ repo: null }))
    })

    it('shows the dir and the port without offering to change them', () => {
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByText('/var/www/arbysauto')).toBeInTheDocument()
        expect(screen.queryByLabelText(/dir/i)).toBeNull()
    })

    it('re-reads the page once the save lands, so the tabs it gates come back enabled', async () => {
        render(<SiteSettingsForm {...props} />)
        await userEvent.click(screen.getByRole('checkbox', { name: /env/ }))
        await userEvent.click(screen.getByRole('button', { name: /save/i }))
        expect(refresh).toHaveBeenCalled()
    })

    it('keeps what was typed when hostd refuses it', async () => {
        saveSettingsAction.mockResolvedValue({ ok: false, error: 'branch needs repo' })
        render(<SiteSettingsForm {...props} />)

        await userEvent.type(screen.getByLabelText(/branch/i), 'main')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(await screen.findByText(/branch needs repo/)).toBeInTheDocument()
        expect(screen.getByLabelText(/branch/i)).toHaveValue('main')
        expect(refresh).not.toHaveBeenCalled()
    })

    it('says what it cannot check, rather than pretending', async () => {
        // A deploy needs a git repository already at <dir>/.git and hostd only finds out when it runs
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByText(/git repository/i)).toBeInTheDocument()
    })
})
```

- [ ] **Step 2: Run and watch fail**

```bash
npx vitest run --project dom "app/(portal)/portal/sites/[id]/settings.test.tsx"
```

- [ ] **Step 3: Write the action**

In `actions.ts`, beside `saveEnvAction`:

```ts
// Editing the registry entry is the operator's alone. hostd refuses a client outright (configure is in
// its ADMIN_ONLY list, ahead of ownership), and this is the same rule applied a step earlier.
export async function saveSettingsAction(id: string, settings: SiteSettings): Promise<SiteActionResult> {
    const allowed = await allow(id, true)
    if (!allowed.ok) return allowed

    const result = await writeSettings(allowed.config, allowed.caller, id, settings)
    if (!result.ok) return refused(`settings on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: 'Saved. Nothing was started or stopped: this only changes what the site is allowed to do.' }
}
```

- [ ] **Step 4: Write the form**

A client component holding one piece of state per section, sending all three fields on save. Points that the tests above pin down, and that matter:

- The eight capabilities come from one local constant with a note per entry, not from a bare string list. `files`, `backups`, `domains` and `provision` carry `built: false`, and the form says so once rather than eight times.
- `provision` says what it grants: the project can be re-provisioned and removed through the API.
- An empty repo field sends `null`, not `''`. An empty branch field sends `null` too.
- Use `ui/Field` for the text inputs and `ui/Button` for Save. Checkboxes: check whether `ui/Field` supports `type="checkbox"` before writing one by hand; if it does not, the markup lives in this file with its own label association, and the styles go in `site.module.css` using tokens only.
- On `ok`, call `router.refresh()`. On refusal, keep the form's state and show hostd's words in a `Callout tone="crit"`.

- [ ] **Step 5: Run the tests**

- [ ] **Step 6: Commit**

```bash
git add "app/(portal)/portal/sites/[id]/settings.tsx" "app/(portal)/portal/sites/[id]/settings.test.tsx" "app/(portal)/portal/sites/[id]/actions.ts" "app/(portal)/portal/sites/[id]/site.module.css"
git commit -m "Build the settings form"
```

---

### Task 7: The tab, and the Environment tab's disabled state

**Files:**
- Modify: `app/(portal)/portal/sites/[id]/page.tsx`
- Test: `app/(portal)/portal/sites/[id]/page.test.tsx`

**Interfaces:**
- Consumes: `SiteSettingsForm` from Task 6, `Project.repo` from Task 4.
- Produces: nothing further.

- [ ] **Step 1: Write the failing tests**

```tsx
it('gives the operator a Settings tab', async () => {
    render(await page())
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument()
})

it('gives a client none, because what their site is allowed to do is not theirs to see', async () => {
    callerFromSession.mockResolvedValue(client)
    render(await page())
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull()
})

it('lands a client asking for it on Overview', async () => {
    callerFromSession.mockResolvedValue(client)
    render(await page({ tab: 'settings' }))
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
})

it('shows the form with the entry as it stands', async () => {
    listProjects.mockResolvedValue({ ok: true, value: [
        { id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle'], repo: 'git@github.com:ItsKodas/asot.git', environments: [{ name: 'live', branch: null }] },
    ] })
    render(await page({ tab: 'settings' }))
    expect(screen.getByLabelText(/repo/i)).toHaveValue('git@github.com:ItsKodas/asot.git')
})

// Until env is ticked the panel showed hostd's refusal, which reads as broken rather than as off
it('disables the Environment tab until the capability is on, and says where it is turned on', async () => {
    listProjects.mockResolvedValue({ ok: true, value: [{ id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle'], environments: [] }] })
    render(await page())
    expect(screen.getByRole('tab', { name: 'Environment' })).toHaveAttribute('aria-disabled', 'true')
})

it('enables it once it is', async () => {
    listProjects.mockResolvedValue({ ok: true, value: [{ id: 'asot', name: 'ASOT', valid: true, capabilities: ['lifecycle', 'env'], environments: [] }] })
    render(await page())
    expect(screen.getByRole('tab', { name: 'Environment' })).not.toHaveAttribute('aria-disabled', 'true')
})

it('offers no form for an entry the registry could not parse', async () => {
    // configure runs the same checkStructure every verb does, so hostd would refuse it
    listProjects.mockResolvedValue({ ok: true, value: [{ id: 'asot', name: 'ASOT', valid: false, reason: 'dir must be /var/www/<one segment>', environments: [] }] })
    render(await page({ tab: 'settings' }))
    expect(screen.getByText(/dir must be/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
})
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Wire it**

- `TabId` gains `'settings'`.
- The tabs array gains, for `view.isAdmin` only: `{ id: 'settings' as const, label: 'Settings' }`.
- The `env` tab entry gains `disabled: !view.capabilities.includes('env')`, and its `WAITING` entry says the Settings tab is where it is switched on. Read how `deploys` does this at `page.tsx:152` and follow it exactly; note that the `WAITING` fallback at the bottom of the panel has a condition per tab that has a real panel, and `settings` and `env` both now need to be in it.
- `SiteView` carries `capabilities` already. It does **not** carry `repo`: add it, alongside `environments`, from the same `project` the gatherer already found (`app/(portal)/portal/sites/[id]/site.ts`). Update `site.test.ts` for the new field.
- The panel renders `<SiteSettingsForm id={view.id} capabilities={view.capabilities} repo={view.repo} environments={view.environments} />`, or a `Callout tone="warn"` carrying `reason` when the entry is invalid.

- [ ] **Step 4: Run the full portal suite**

```bash
npx vitest run && npx tsc --noEmit && npm run lint && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add "app/(portal)/portal/sites/[id]"
git commit -m "Put the settings tab on the site page"
```

---

### Task 8: The runbook

**Files:**
- Modify: `hostd/RUNBOOK.md`

- [ ] **Step 1: Write it**

In **Deploying**, replace the opening paragraph's "Nothing else switches it on" with what is now true: `capabilities`, `repo` and `branch` are set from the site's Settings tab in the portal, and the portal converts a live-only entry to the environments shape the first time a branch is set on it. Say plainly what the portal still cannot do: `services`, `storage`, `limits`, `compose`, `domain`, `port`, `certificate`, `client` and `dir` are all still hand-edited, and the last two deliberately so.

In **Enrolling a real site**, add a step after the existing step 5: the remaining setup is in the portal now, and it lists what the tab covers.

Check the line in **Calling the API from the dedi** that says "The portal does not exist yet" and correct it while you are here.

- [ ] **Step 2: Commit**

```bash
git add hostd/RUNBOOK.md
git commit -m "Say in the runbook that settings are set from the portal"
```

---

## Verification, before opening the PR

```bash
cd hostd && npm test && npm run typecheck && cd ..
npx vitest run && npx tsc --noEmit && npm run lint && npm run build
```

The one thing no test here can reach: hostd is not running in this environment, so nothing in this plan has been tried against the real registry. Say so in the PR rather than implying otherwise, and say that the first real use should be one site, checked with `hc http://hostd-api:8080/projects` afterwards, before the other four.
