# Watching a deploy live: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A column on the portal's Deploys tab that fills line by line while a deploy runs, showing the deploy's own phase lines with `docker compose` output beneath the build step.

**Architecture:** The deploy already narrates itself through `deps.log`. `DeployRunner` wraps `log` and `runner` per deploy so both feed a bounded per-environment ring buffer; a new `deploy-watch` verb serves that buffer as the same stream `Outcome` container logs already use; the api serves it on `GET` of the path `POST` already owns; the portal consumes it with an `EventSource` the way `logs.tsx` does.

**Tech Stack:** TypeScript on Node 22 (`node:test`, `tsx`, no test framework), Next.js 15 App Router for the portal, plain CSS modules.

**Spec:** `docs/superpowers/specs/2026-09-23-deploy-log-stream-design.md`

## Global Constraints

- **No em dashes anywhere**: not in code comments, copy, commit messages or docs. Use a comma, colon, full stop or parentheses. (`CLAUDE.md`)
- **Every bug fix and feature gets a test watched failing first.** Not a test that passes afterwards, one seen failing against the old code.
- **Comments say why, not what.**
- Run from `hostd/`: `npm test` (all of `src/**/*.test.ts`), `npm run typecheck`. Both must be clean before any commit.
- Portal tests run from the repo root with the project's existing runner.
- `record.output` must stay byte for byte what it is today. It is the regression most likely to break silently.
- The line sink takes **both** stdout and stderr. The spike found compose v5.1.3 writing progress to stdout and only its closing summary to stderr, contradicting `deploy-compose.ts`'s own comment.
- Never widen who can see deploy output. The stream is gated by the `deploy` capability and the same owner policy the deploy history already uses.

## File structure

| File | Responsibility |
| --- | --- |
| `hostd/src/shared/deploys.ts` | modify: `DeployEvent`, `MAX_WATCH_BYTES` |
| `hostd/src/agent/compose.ts` | modify: `Runner` gains `onLine`, `createSpawnRunner` feeds it, line splitter |
| `hostd/src/agent/deploy-watch.ts` | create: the buffer and its subscribers, nothing else |
| `hostd/src/agent/deploy-runner.ts` | modify: own a `DeployWatch`, wrap `log` and `runner` per deploy |
| `hostd/src/shared/protocol.ts` | modify: the `deploy-watch` verb and its parse |
| `hostd/src/agent/agent.ts` | modify: the handler returning the stream |
| `hostd/src/api/routes.ts` | modify: method switch on the deploy path, stream handler |
| `hostd/src/agent/index.ts` | modify: pass the watch into the agent's deploys deps |
| `server/hostd/deployWatch.ts` | create: opens the upstream stream, mirrors `logs.ts` |
| `server/hostd/relay.ts` | modify: `relayDeployWatch` |
| `app/api/sites/[id]/deploy/route.ts` | create: the portal's GET proxy |
| `app/(portal)/portal/sites/[id]/deployLog.tsx` | create: the column |
| `app/(portal)/portal/sites/[id]/site.module.css` | modify: the two column grid |
| `app/(portal)/portal/sites/[id]/deployPanel.tsx` | modify: render the column beside the content |
| `hostd/RUNBOOK.md` | modify: one paragraph on watching a deploy |

---

### Task 1: The event type and the buffer bound

**Files:**
- Modify: `hostd/src/shared/deploys.ts`
- Test: `hostd/src/shared/deploys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DeployEvent = { at: string, startedAt: string, kind: 'step' | 'output' | 'end', text: string }`, `const MAX_WATCH_BYTES: number`.

- [ ] **Step 1: Write the failing test**

Append to `hostd/src/shared/deploys.test.ts`:

```ts
describe('deploy watch bounds', () => {
    // Its own number rather than OUTPUT_TAIL_BYTES: that one bounds the tail of one command stored in a
    // record, this bounds a whole deploy's narrative and output held in memory. Different reasons, so
    // they must not drift together.
    it('bounds a watched deploy well above a single record tail', () => {
        assert.ok(MAX_WATCH_BYTES >= 64 * 1024, String(MAX_WATCH_BYTES))
    })
})
```

Add `MAX_WATCH_BYTES` to that file's existing import from `./deploys.ts`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd hostd && npx tsx --test src/shared/deploys.test.ts`
Expected: FAIL, the import of `MAX_WATCH_BYTES` does not resolve.

- [ ] **Step 3: Add the type and the constant**

In `hostd/src/shared/deploys.ts`:

```ts
// One line of a deploy as it happens. `step` is the deploy narrating itself (the deps.log calls
// runDeploy already makes), `output` is a line docker compose printed, and `end` is the last event of a
// deploy: its text is the outcome, the reason when there is one, and the duration, so a watcher knows it
// is over and how it went without polling the history.
//
// startedAt identifies the deploy. One stream carries a sequence of deploys, so this is what tells a
// watcher that the lines arriving now belong to a different one from the lines above them.
export type DeployEvent = {
    at: string
    startedAt: string
    kind: 'step' | 'output' | 'end'
    text: string
}

// How much of one deploy is kept for a watcher who has not attached yet. Most deploys are started by the
// poller with nobody watching, so this is what stops a chatty build costing anything unbounded.
export const MAX_WATCH_BYTES = 256 * 1024
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd hostd && npx tsx --test src/shared/deploys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/deploys.ts hostd/src/shared/deploys.test.ts
git commit -m "Name what one line of a running deploy is"
```

---

### Task 2: The runner's optional line sink

**Files:**
- Modify: `hostd/src/agent/compose.ts`
- Test: `hostd/src/agent/compose.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Runner = (command: string, args: string[], timeoutMs: number, onLine?: (line: string) => void) => Promise<RunResult>`. Every existing caller keeps working unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `hostd/src/agent/compose.test.ts`. The fake spawn in that file is the one to reuse; if it does not already let a test push chunks, add a local one in this describe block:

```ts
describe('createSpawnRunner line sink', () => {
    // Both streams, not just stderr. deploy-compose.ts carries a comment saying compose writes its
    // progress to stderr; a spike against compose v5.1.3 found progress on stdout and only the closing
    // summary on stderr. Listening to one would have shown a single line per deploy.
    it('hands lines from stdout and stderr to the sink, in arrival order', async () => {
        const child = fakeChild()
        const runner = createSpawnRunner(() => child as never)
        const lines: string[] = []
        const done = runner('docker', ['compose', 'build'], 1000, line => lines.push(line))
        child.stdout.emit('data', Buffer.from('#6 [2/3] RUN echo A\n'))
        child.stderr.emit('data', Buffer.from(' Image probe Built \n'))
        child.emit('close', 0)
        await done
        assert.deepEqual(lines, ['#6 [2/3] RUN echo A', ' Image probe Built '])
    })

    it('joins a line split across two chunks rather than emitting half of it', async () => {
        const child = fakeChild()
        const runner = createSpawnRunner(() => child as never)
        const lines: string[] = []
        const done = runner('docker', ['compose', 'build'], 1000, line => lines.push(line))
        child.stdout.emit('data', Buffer.from('#7 4.30 B-D'))
        child.stdout.emit('data', Buffer.from('ONE\n'))
        child.emit('close', 0)
        await done
        assert.deepEqual(lines, ['#7 4.30 B-DONE'])
    })

    // A command whose last line has no trailing newline still said it.
    it('emits a trailing partial line when the child closes', async () => {
        const child = fakeChild()
        const runner = createSpawnRunner(() => child as never)
        const lines: string[] = []
        const done = runner('docker', ['compose', 'build'], 1000, line => lines.push(line))
        child.stdout.emit('data', Buffer.from('no newline at the end'))
        child.emit('close', 0)
        await done
        assert.deepEqual(lines, ['no newline at the end'])
    })

    // The regression that matters. RunResult is what becomes record.output, and it must not change.
    it('leaves RunResult exactly as it is, sink or no sink', async () => {
        const withSink = fakeChild()
        const a = createSpawnRunner(() => withSink as never)('docker', ['x'], 1000, () => {})
        withSink.stdout.emit('data', Buffer.from('one\ntwo\n'))
        withSink.emit('close', 0)

        const without = fakeChild()
        const b = createSpawnRunner(() => without as never)('docker', ['x'], 1000)
        without.stdout.emit('data', Buffer.from('one\ntwo\n'))
        without.emit('close', 0)

        assert.deepEqual(await a, await b)
    })
})
```

If `compose.test.ts` has no `fakeChild`, add it above the describe block:

```ts
import { EventEmitter } from 'node:events'

// A child process as far as createSpawnRunner is concerned: two streams and a close event.
function fakeChild() {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter, stderr: EventEmitter, kill: () => void }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    return child
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd hostd && npx tsx --test src/agent/compose.test.ts`
Expected: the three sink tests FAIL (the sink is never called, so `lines` stays empty). The `RunResult` test passes already, which is correct: it is a guard, not a driver.

- [ ] **Step 3: Widen the type and feed the sink**

In `hostd/src/agent/compose.ts`, change the type:

```ts
// onLine is how a caller watches a command as it runs rather than after it. Optional, so every existing
// caller is untouched, and RunResult is unchanged, which is what keeps record.output byte for byte what
// it has always been.
export type Runner = (
    command: string, args: string[], timeoutMs: number, onLine?: (line: string) => void,
) => Promise<RunResult>
```

Add the splitter above `createSpawnRunner`:

```ts
// Chunks off a pipe do not respect line boundaries: a line can arrive in two pieces, and two lines can
// arrive in one. This holds the tail until its newline turns up. The trailing \r is stripped because a
// command that thinks it might be on a terminal still sends them.
function lineSplitter(emit: (line: string) => void) {
    let rest = ''
    return {
        push(chunk: Buffer): void {
            const parts = (rest + chunk.toString('utf8')).split('\n')
            rest = parts.pop() ?? ''
            for (const part of parts) emit(part.endsWith('\r') ? part.slice(0, -1) : part)
        },
        flush(): void {
            if (rest === '') return
            const last = rest.endsWith('\r') ? rest.slice(0, -1) : rest
            rest = ''
            emit(last)
        },
    }
}
```

In `createSpawnRunner`, take the fourth argument and feed it:

```ts
return (command, args, timeoutMs, onLine) => new Promise(resolve => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(envKeys) })
    const stdout = new Capture()
    const stderr = new Capture()
    const splitter = onLine ? lineSplitter(onLine) : null
    child.stdout?.on('data', (chunk: Buffer) => { stdout.add(chunk); splitter?.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr.add(chunk); splitter?.push(chunk) })
```

and in `finish`, before `resolve`:

```ts
    splitter?.flush()
```

- [ ] **Step 4: Run the whole suite**

Run: `cd hostd && npm test && npm run typecheck`
Expected: every test passes, including the four new ones. If any existing caller of `Runner` fails to typecheck, the type was widened wrongly: the new parameter is optional and last.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/compose.ts hostd/src/agent/compose.test.ts
git commit -m "Let a caller watch a command's output as it runs"
```

---

### Task 3: The watch buffer

**Files:**
- Create: `hostd/src/agent/deploy-watch.ts`
- Test: `hostd/src/agent/deploy-watch.test.ts`

**Interfaces:**
- Consumes: `DeployEvent`, `MAX_WATCH_BYTES` from Task 1.
- Produces:
  ```ts
  class DeployWatch {
      constructor(now: () => number, maxBytes?: number)
      begin(key: string, startedAt: string): void
      step(key: string, text: string): void
      output(key: string, text: string): void
      end(key: string, text: string): void
      replay(key: string): DeployEvent[]
      subscribe(key: string, listener: (event: DeployEvent) => void): () => void
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `hostd/src/agent/deploy-watch.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeployWatch } from './deploy-watch.ts'

const KEY = 'acme:live'
const AT = '2026-09-23T05:00:00.000Z'
const clock = () => Date.parse(AT)

describe('DeployWatch', () => {
    it('replays what a deploy printed to somebody who was not watching yet', () => {
        const watch = new DeployWatch(clock)
        watch.begin(KEY, AT)
        watch.step(KEY, 'building')
        watch.output(KEY, '#7 [4/9] RUN npm ci')
        assert.deepEqual(watch.replay(KEY), [
            { at: AT, startedAt: AT, kind: 'step', text: 'building' },
            { at: AT, startedAt: AT, kind: 'output', text: '#7 [4/9] RUN npm ci' },
        ])
    })

    it('gives a subscriber the events that arrive after it subscribes', () => {
        const watch = new DeployWatch(clock)
        watch.begin(KEY, AT)
        const seen: string[] = []
        watch.subscribe(KEY, event => seen.push(`${event.kind}:${event.text}`))
        watch.step(KEY, 'swapping')
        watch.end(KEY, 'deployed in 9s')
        assert.deepEqual(seen, ['step:swapping', 'end:deployed in 9s'])
    })

    it('feeds several subscribers at once', () => {
        const watch = new DeployWatch(clock)
        watch.begin(KEY, AT)
        const a: string[] = []
        const b: string[] = []
        watch.subscribe(KEY, e => a.push(e.text))
        watch.subscribe(KEY, e => b.push(e.text))
        watch.step(KEY, 'building')
        assert.deepEqual(a, ['building'])
        assert.deepEqual(b, ['building'])
    })

    it('stops feeding one that has unsubscribed, and leaves the others alone', () => {
        const watch = new DeployWatch(clock)
        watch.begin(KEY, AT)
        const a: string[] = []
        const b: string[] = []
        const off = watch.subscribe(KEY, e => a.push(e.text))
        watch.subscribe(KEY, e => b.push(e.text))
        off()
        watch.step(KEY, 'building')
        assert.deepEqual(a, [])
        assert.deepEqual(b, ['building'])
    })

    // The idle state the portal shows: the last deploy's output stays until the next one starts.
    it('keeps the finished deploy until the next one begins, then clears it', () => {
        const watch = new DeployWatch(clock)
        watch.begin(KEY, AT)
        watch.step(KEY, 'building')
        watch.end(KEY, 'deployed in 9s')
        assert.equal(watch.replay(KEY).length, 2)

        watch.begin(KEY, '2026-09-23T06:00:00.000Z')
        assert.deepEqual(watch.replay(KEY), [])
    })

    it('keeps one environment's events out of another's', () => {
        const watch = new DeployWatch(clock)
        watch.begin(KEY, AT)
        watch.begin('acme:test', AT)
        watch.step(KEY, 'live line')
        assert.deepEqual(watch.replay('acme:test'), [])
    })

    // A chatty build must cost a fixed amount, because most deploys have nobody watching.
    it('drops the oldest events once the buffer is full, and keeps the newest', () => {
        const watch = new DeployWatch(clock, 200)
        watch.begin(KEY, AT)
        for (let i = 0; i < 50; i += 1) watch.output(KEY, `line ${i} ${'x'.repeat(20)}`)
        const kept = watch.replay(KEY)
        assert.ok(kept.length < 50, String(kept.length))
        assert.ok(kept[kept.length - 1]!.text.startsWith('line 49'), kept[kept.length - 1]!.text)
    })

    // A deploy nobody began, which should never happen, must not throw into the middle of a deploy.
    it('ignores an event for a key with no deploy begun', () => {
        const watch = new DeployWatch(clock)
        assert.doesNotThrow(() => watch.step(KEY, 'stray'))
        assert.deepEqual(watch.replay(KEY), [])
    })
})
```

Note: in the sixth test the apostrophe inside the test name needs escaping or the name should be rewritten without it. Prefer rewriting: `'keeps one environment events out of another'`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd hostd && npx tsx --test src/agent/deploy-watch.test.ts`
Expected: FAIL, `./deploy-watch.ts` does not exist.

- [ ] **Step 3: Write it**

Create `hostd/src/agent/deploy-watch.ts`:

```ts
// What a deploy printed, for anybody who wants to watch it. One bounded buffer per environment, with
// whoever is subscribed to that environment right now.
//
// The buffer is what makes attaching mid-deploy work at all: a watcher arriving late gets everything so
// far replayed, then live events, so a reload during a build and a deploy the poller started an hour
// after anybody last looked both behave the same way. It is bounded because most deploys are started by
// the poller with nobody watching, and an unwatched deploy must cost a fixed amount.
//
// Deliberately in memory only. An agent restart kills the deploy it belonged to as well (a deploy is an
// in-process promise), so a buffer that outlived the process would only describe something that is no
// longer happening. The deploy history remains the durable record.

import { MAX_WATCH_BYTES, type DeployEvent } from '../shared/deploys.ts'

type Buffered = { startedAt: string, events: DeployEvent[], bytes: number }

export class DeployWatch {
    private readonly buffers = new Map<string, Buffered>()
    private readonly listeners = new Map<string, Set<(event: DeployEvent) => void>>()

    constructor(private readonly now: () => number, private readonly maxBytes: number = MAX_WATCH_BYTES) {}

    // Clears whatever the previous deploy left. Called once per deploy, before anything else for it.
    begin(key: string, startedAt: string): void {
        this.buffers.set(key, { startedAt, events: [], bytes: 0 })
    }

    step(key: string, text: string): void {
        this.add(key, 'step', text)
    }

    output(key: string, text: string): void {
        this.add(key, 'output', text)
    }

    end(key: string, text: string): void {
        this.add(key, 'end', text)
    }

    replay(key: string): DeployEvent[] {
        return [...(this.buffers.get(key)?.events ?? [])]
    }

    subscribe(key: string, listener: (event: DeployEvent) => void): () => void {
        const set = this.listeners.get(key) ?? new Set()
        set.add(listener)
        this.listeners.set(key, set)
        return () => {
            const current = this.listeners.get(key)
            if (!current) return
            current.delete(listener)
            if (current.size === 0) this.listeners.delete(key)
        }
    }

    private add(key: string, kind: DeployEvent['kind'], text: string): void {
        const buffered = this.buffers.get(key)
        // No deploy has begun for this key. Not a reason to throw into the middle of one.
        if (!buffered) return

        const event: DeployEvent = { at: new Date(this.now()).toISOString(), startedAt: buffered.startedAt, kind, text }
        buffered.events.push(event)
        buffered.bytes += Buffer.byteLength(text)
        while (buffered.bytes > this.maxBytes && buffered.events.length > 1) {
            const dropped = buffered.events.shift()
            buffered.bytes -= Buffer.byteLength(dropped?.text ?? '')
        }

        // A listener that throws is a bug in that listener, and must not take the deploy down with it.
        for (const listener of this.listeners.get(key) ?? []) {
            try {
                listener(event)
            } catch {
                // Nothing to do here: the deploy is what matters, and it is not this listener's business.
            }
        }
    }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd hostd && npx tsx --test src/agent/deploy-watch.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/deploy-watch.ts hostd/src/agent/deploy-watch.test.ts
git commit -m "Keep what a running deploy printed, for whoever wants to watch it"
```

---

### Task 4: Wire the buffer into a deploy

**Files:**
- Modify: `hostd/src/agent/deploy-runner.ts`
- Test: `hostd/src/agent/deploy-runner.test.ts`

**Interfaces:**
- Consumes: `DeployWatch` from Task 3, the widened `Runner` from Task 2.
- Produces: `DeployRunner` gains a public `readonly watch: DeployWatch`, read by Task 6's agent handler.

- [ ] **Step 1: Write the failing tests**

Append to `hostd/src/agent/deploy-runner.test.ts`:

```ts
describe('DeployRunner watch', () => {
    // The narrative comes out of code that already exists: runDeploy calls deps.log at every phase, and
    // those calls are what a watcher reads. Nothing in runDeploy changes.
    it('tees every deps.log line from a deploy into the buffer as a step', async () => {
        const seen: string[] = []
        const runner = makeRunner({
            deploy: async (_project, _environment, _request, deps) => {
                deps.log('deploy acme live abc1234: building')
                return okRecord()
            },
        })
        runner.watch.subscribe('acme:live', event => seen.push(`${event.kind}:${event.text}`))
        runner.start(project(), environment(), { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        assert.ok(seen.includes('step:deploy acme live abc1234: building'), seen.join(' | '))
    })

    it('tees a command line from inside a deploy into the buffer as output', async () => {
        const seen: string[] = []
        const runner = makeRunner({
            deploy: async (_project, _environment, _request, deps) => {
                await deps.runner('docker', ['compose', 'build'], 1000)
                return okRecord()
            },
            runnerLines: ['#7 [4/9] RUN npm ci'],
        })
        runner.watch.subscribe('acme:live', event => seen.push(`${event.kind}:${event.text}`))
        runner.start(project(), environment(), { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        assert.ok(seen.includes('output:#7 [4/9] RUN npm ci'), seen.join(' | '))
    })

    it('ends the buffer with the outcome, so a watcher need not poll the history', async () => {
        const seen: string[] = []
        const runner = makeRunner({ deploy: async () => okRecord() })
        runner.watch.subscribe('acme:live', event => seen.push(`${event.kind}:${event.text}`))
        runner.start(project(), environment(), { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        const last = seen[seen.length - 1] ?? ''
        assert.ok(last.startsWith('end:'), last)
        assert.ok(last.includes('deployed'), last)
    })

    it('says why on the end event when a deploy fails', async () => {
        const seen: string[] = []
        const runner = makeRunner({ deploy: async () => failedRecord('build exited with code 1') })
        runner.watch.subscribe('acme:live', event => seen.push(`${event.kind}:${event.text}`))
        runner.start(project(), environment(), { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        const last = seen[seen.length - 1] ?? ''
        assert.ok(last.includes('build exited with code 1'), last)
    })

    // The agent's own log is not the portal's. A deploy still narrates itself to stdout exactly as before.
    it('still writes every line to the agent log as well', async () => {
        const logged: string[] = []
        const runner = makeRunner({
            log: line => logged.push(line),
            deploy: async (_project, _environment, _request, deps) => {
                deps.log('building')
                return okRecord()
            },
        })
        runner.start(project(), environment(), { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        assert.ok(logged.includes('building'), logged.join(' | '))
    })
})
```

Add the helpers this describe block needs near the file's existing ones. `makeRunner` builds a `DeployRunner` over the file's existing fake deps, with these additions: `log` defaults to a no-op collector, and the fake runner calls its fourth argument once per entry in `runnerLines` before resolving.

```ts
function okRecord(): DeployRecord {
    return {
        commit: 'abc1234', subject: null, actor: 'koda', trigger: 'manual',
        startedAt: '2026-09-23T05:00:00.000Z', durationMs: 9000, outcome: 'ok', reason: null, output: null,
    }
}

function failedRecord(reason: string): DeployRecord {
    return { ...okRecord(), outcome: 'failed', reason }
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd hostd && npx tsx --test src/agent/deploy-runner.test.ts`
Expected: FAIL, `runner.watch` is undefined.

- [ ] **Step 3: Wire it**

In `hostd/src/agent/deploy-runner.ts`, add the import and the field:

```ts
import { DeployWatch } from './deploy-watch.ts'
```

```ts
export class DeployRunner {
    private readonly running = new Map<string, Promise<void>>()
    // Beside `running`, and for the same reason: this class is what knows a deploy is happening.
    readonly watch = new DeployWatch(this.deps.now)
```

In `private async run(...)`, before the deploy is awaited, build the per-deploy deps and begin the buffer:

```ts
private async run(key, project, environment, request): Promise<void> {
    const startedAt = new Date(this.deps.now()).toISOString()
    this.watch.begin(key, startedAt)
    // runDeploy needs no knowledge of any of this. It already narrates itself through deps.log at every
    // phase, and it already reaches every command through deps.runner, so wrapping those two here is the
    // whole of how a deploy becomes watchable.
    const deps: DeployDeps = {
        ...this.deps,
        log: line => { this.deps.log(line); this.watch.step(key, line) },
        runner: (command, args, timeoutMs, onLine) => this.deps.runner(command, args, timeoutMs, line => {
            this.watch.output(key, line)
            onLine?.(line)
        }),
    }
    try {
        if (request.trigger !== 'poll') await this.deps.store.resume(key)
        let record: DeployRecord
        try {
            record = await this.deploy(project, environment, request, deps)
        } catch (error) {
            ...unchanged...
        }
        this.watch.end(key, endText(record))
        ...the rest unchanged, still recording to the store...
```

Add the helper at the bottom of the file:

```ts
// What a watcher sees last. The outcome and the duration always, the reason when there is one, so the
// panel can stop without asking the history what happened.
function endText(record: DeployRecord): string {
    const seconds = `${Math.round(record.durationMs / 1000)}s`
    const outcome = record.outcome === 'ok' ? 'deployed' : record.outcome
    return record.reason ? `${outcome} in ${seconds}: ${record.reason}` : `${outcome} in ${seconds}`
}
```

Make sure `this.watch.end(...)` also runs on the `catch` path, so a deploy that throws still closes its stream. Put it immediately after `record` is assigned in both branches, which the shape above already does.

- [ ] **Step 4: Run the suite**

Run: `cd hostd && npm test && npm run typecheck`
Expected: all pass. `deploy.test.ts` must be untouched by this: `runDeploy` has not changed.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/deploy-runner.ts hostd/src/agent/deploy-runner.test.ts
git commit -m "Tee a deploy's own narration and output to whoever is watching"
```

---

### Task 5: The deploy-watch verb

**Files:**
- Modify: `hostd/src/shared/protocol.ts`
- Test: `hostd/src/shared/protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DeployWatchRequest = { verb: 'deploy-watch', project: string, args: { environment: EnvironmentName } }`, added to the `AgentRequest` union.

- [ ] **Step 1: Write the failing tests**

Append to `hostd/src/shared/protocol.test.ts`:

```ts
describe('deploy-watch', () => {
    it('reads a watch for one environment', () => {
        const result = parseAgentRequest(JSON.stringify({ verb: 'deploy-watch', project: 'acme', args: { environment: 'live' } }))
        assert.deepEqual(result, { ok: true, request: { verb: 'deploy-watch', project: 'acme', args: { environment: 'live' } } })
    })

    it('refuses a malformed project, a bad environment and an extra field', () => {
        assert.equal(refusalOf({ verb: 'deploy-watch', project: '../acme', args: { environment: 'live' } }), 'bad-request: project is malformed')
        assert.equal(refusalOf({ verb: 'deploy-watch', project: 'acme', args: { environment: 'staging' } }), 'bad-request: environment must be live or test')
        assert.equal(refusalOf({ verb: 'deploy-watch', project: 'acme', args: { environment: 'live', follow: true } }), 'bad-request: deploy-watch takes only environment')
    })
})
```

Match `refusalOf`'s exact existing shape in that file: it returns `code: message`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd hostd && npx tsx --test src/shared/protocol.test.ts`
Expected: FAIL with `unknown verb`.

- [ ] **Step 3: Add the verb**

In `hostd/src/shared/protocol.ts`, beside `DeployRequest`:

```ts
// Its own verb rather than a deploy action, because every action in parseDeployArgs answers with an
// AgentReply and this answers with a stream. logs is the same shape for the same reason.
export type DeployWatchRequest = { verb: 'deploy-watch', project: string, args: { environment: EnvironmentName } }
```

Add `DeployWatchRequest` to the `AgentRequest` union beside `DeployRequest`, and add the parse case alongside the other project verbs:

```ts
case 'deploy-watch': {
    const project = projectOf(raw)
    if (!project) return refuse('bad-request', 'project is malformed')
    if (!isRecord(raw.args)) return refuse('bad-request', 'deploy-watch requires args')
    if (!onlyKeys(raw.args, ['environment'])) return refuse('bad-request', 'deploy-watch takes only environment')
    const environment = raw.args.environment
    if (typeof environment !== 'string' || !(ENVIRONMENTS as readonly string[]).includes(environment)) {
        return refuse('bad-request', 'environment must be live or test')
    }
    return { ok: true, request: { verb: 'deploy-watch', project, args: { environment: environment as EnvironmentName } } }
}
```

Use whatever this file already calls its project-id helper rather than introducing `projectOf` if it is named something else; read the neighbouring `deploy` case and copy its exact idiom.

- [ ] **Step 4: Run them and watch them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS. Any `switch` over `AgentRequest['verb']` that is now non-exhaustive will fail typecheck; that is the compiler pointing at Task 6.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/protocol.ts hostd/src/shared/protocol.test.ts
git commit -m "Give watching a deploy its own verb"
```

---

### Task 6: The agent serves the stream

**Files:**
- Modify: `hostd/src/agent/agent.ts`, `hostd/src/agent/index.ts`
- Test: `hostd/src/agent/agent.test.ts`

**Interfaces:**
- Consumes: `DeployRunner.watch` (Task 4), `DeployWatchRequest` (Task 5).
- Produces: the agent answers `deploy-watch` with `{ kind: 'stream', lines, close }`.

- [ ] **Step 1: Write the failing tests**

Append to `hostd/src/agent/agent.test.ts`:

```ts
describe('deploy-watch', () => {
    it('replays what the deploy printed before anybody attached, then goes live', async () => {
        const { agent, deploys } = setup()
        deploys.runner.watch.begin('acme:live', '2026-09-23T05:00:00.000Z')
        deploys.runner.watch.step('acme:live', 'building')

        const outcome = await agent.handle({ verb: 'deploy-watch', project: 'acme', args: { environment: 'live' } })
        assert.equal(outcome.kind, 'stream')
        if (outcome.kind !== 'stream') return

        const reader = outcome.lines[Symbol.asyncIterator]()
        assert.equal((await reader.next()).value.text, 'building')

        deploys.runner.watch.output('acme:live', '#7 RUN npm ci')
        assert.equal((await reader.next()).value.text, '#7 RUN npm ci')
        outcome.close()
    })

    it('refuses an environment the project does not have, without opening a stream', async () => {
        const { agent } = setup()
        const outcome = await agent.handle({ verb: 'deploy-watch', project: 'acme', args: { environment: 'test' } })
        assert.equal(outcome.kind, 'reply')
        if (outcome.kind !== 'reply') return
        assert.equal(outcome.reply.ok, false)
    })

    it('refuses when the deploys rail is not wired, exactly as the deploy verb does', async () => {
        const { agent } = setup({ deploys: undefined })
        const outcome = await agent.handle({ verb: 'deploy-watch', project: 'acme', args: { environment: 'live' } })
        assert.equal(outcome.kind, 'reply')
        if (outcome.kind !== 'reply') return
        assert.equal(outcome.reply.ok === false && outcome.reply.code, 'unavailable')
    })

    it('stops feeding a stream that has been closed', async () => {
        const { agent, deploys } = setup()
        deploys.runner.watch.begin('acme:live', '2026-09-23T05:00:00.000Z')
        const outcome = await agent.handle({ verb: 'deploy-watch', project: 'acme', args: { environment: 'live' } })
        assert.equal(outcome.kind, 'stream')
        if (outcome.kind !== 'stream') return
        outcome.close()
        const done = await outcome.lines[Symbol.asyncIterator]().next()
        assert.equal(done.done, true)
    })
})
```

Use the file's own `setup` helper and its own way of naming the agent's entry point; read a neighbouring `logs` test and copy the idiom exactly. The fake `deploys` dep needs a real `DeployRunner` (or an object carrying a real `DeployWatch` as `runner.watch`), since the point is the wiring.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd hostd && npx tsx --test src/agent/agent.test.ts`
Expected: FAIL, the verb is not handled.

- [ ] **Step 3: Handle it**

In `hostd/src/agent/agent.ts`, widen the stream outcome:

```ts
import type { DeployEvent } from '../shared/deploys.ts'
```

```ts
    // LogLine is shaped for container logs, and its stream: 'stdout' | 'stderr' means nothing for a
    // deploy's phase line. server.ts writes one JSON object per line and does not care which this is.
    | { kind: 'stream', lines: AsyncIterable<LogLine | DeployEvent>, close: () => void }
```

Add the handler, and dispatch `deploy-watch` to it beside the other project verbs:

```ts
private deployWatch(project: ProjectEntry, args: { environment: EnvironmentName }): Outcome {
    const deploys = this.deps.deploys
    if (!deploys) return reply(refuse('unavailable', 'deploys are not wired up on this agent'))
    const environment = environmentOf(project, args.environment)
    if (!environment) return reply(refuse('unknown-environment', `${project.id} has no ${args.environment} environment`))

    const key = deployKey(project.id, args.environment)
    const watch = deploys.runner.watch
    // Everything printed before this watcher arrived, then everything after. The queue is what joins the
    // two without a gap: subscribing first and replaying second would duplicate, the other way round
    // would drop whatever landed in between.
    const queue: DeployEvent[] = watch.replay(key)
    let closed = false
    let wake: (() => void) | null = null
    const unsubscribe = watch.subscribe(key, event => {
        queue.push(event)
        wake?.()
    })
    const close = () => {
        closed = true
        unsubscribe()
        wake?.()
    }
    async function* lines(): AsyncGenerator<DeployEvent> {
        try {
            for (;;) {
                while (queue.length > 0) {
                    const next = queue.shift()
                    if (next) yield next
                }
                if (closed) return
                await new Promise<void>(resolve => { wake = resolve })
                wake = null
            }
        } finally {
            unsubscribe()
        }
    }
    return { kind: 'stream', lines: lines(), close }
}
```

`deploys.runner` is typed `Pick<DeployRunner, 'start'>` today; widen it to `Pick<DeployRunner, 'start' | 'watch'>` in `AgentDeps`.

In `hostd/src/agent/index.ts`, nothing new needs constructing: `watch` is a field on the `DeployRunner` already built there. Confirm the object passed as `deploys.runner` is the runner itself and not a narrowed literal; if it is narrowed, add `watch`.

- [ ] **Step 4: Run the suite**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/agent.ts hostd/src/agent/index.ts hostd/src/agent/agent.test.ts
git commit -m "Answer deploy-watch with the stream the buffer feeds"
```

---

### Task 7: The api route

**Files:**
- Modify: `hostd/src/api/routes.ts`
- Test: `hostd/src/api/routes.test.ts`

**Interfaces:**
- Consumes: the agent's `deploy-watch` (Task 6).
- Produces: `GET /projects/<id>/<env>/deploy` as an SSE stream; `POST` on the same path unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `hostd/src/api/routes.test.ts`:

```ts
describe('watching a deploy', () => {
    it('sends GET and POST on one path to different places', async () => {
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/deploy'), { verb: 'deploy', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/deploy'), { verb: 'deploy-watch', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('DELETE', '/projects/acme/live/deploy'), { verb: 'method-not-allowed' })
    })

    it('opens an event stream for an admin', async () => {
        const response = await request('/projects/acme/live/deploy', { method: 'GET', actor: 'admin' })
        assert.equal(response.status, 200)
        assert.match(response.headers['content-type'] ?? '', /text\/event-stream/)
    })

    // Watching is the same kind of read as the history, which an owner may make.
    it('lets the owning client watch their own site', async () => {
        const response = await request('/projects/acme/live/deploy', { method: 'GET', actor: 'client:cl_1' })
        assert.equal(response.status, 200)
    })

    it('refuses a client who does not own it, before any stream opens', async () => {
        const response = await request('/projects/acme/live/deploy', { method: 'GET', actor: 'client:cl_other' })
        assert.ok(response.status === 403 || response.status === 404, String(response.status))
        assert.equal((response.headers['content-type'] ?? '').includes('event-stream'), false)
    })
})
```

Match the file's own `request` helper signature exactly; read a neighbouring `logs` test.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd hostd && npx tsx --test src/api/routes.test.ts`
Expected: FAIL, `GET` on that path is `method-not-allowed`.

- [ ] **Step 3: Route and serve it**

In `matchRoute`, replace the deploy line inside the environment switch:

```ts
case 'deploy':
    // POST starts one, GET watches the one that is running. Same path on purpose: they are the same
    // subject, and a second segment would only be a different spelling of the same thing.
    if (method === 'POST') return { verb: 'deploy', project, environment }
    if (method === 'GET') return { verb: 'deploy-watch', project, environment }
    return { verb: 'method-not-allowed' }
```

Add `{ verb: 'deploy-watch', project: string, environment: EnvironmentName }` to the `Route` union.

Add the handler case beside `logs`, which it mirrors exactly. The only differences are the verb, the target text and the policy verb:

```ts
case 'deploy-watch': {
    const target = `${route.environment} watch`
    if (!(await decide(route.project, 'deploy-read', target))) return

    let stream: Awaited<ReturnType<AgentClient['stream']>>
    try {
        stream = await deps.agent.stream({ verb: 'deploy-watch', project: route.project, args: { environment: route.environment } })
    } catch (error) {
        if (!(error instanceof AgentUnavailableError)) throw error
        await audit(who, { project: route.project, verb: 'deploy-watch', target, outcome: 'failed', reason: error.message })
        return sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
    }
    if (!stream.ok) return refuseRoute(AGENT_STATUS[stream.code], stream.code, stream.message, route.project, 'deploy-watch', target)
    await audit(who, { project: route.project, verb: 'deploy-watch', target, outcome: 'ok' })

    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
    })
    const eventStream = stream
    const stop = () => eventStream.close()
    res.on('close', stop)
    // A build can sit silent for minutes pulling layers, so this matters more here than for container
    // logs: without it an idle proxy closes the connection mid-deploy.
    const keepalive = setInterval(() => res.write(SSE_KEEPALIVE), deps.keepaliveMs ?? KEEPALIVE_MS)
    try {
        for await (const line of eventStream.lines) {
            if (!res.write(sseEvent('line', line))) await waitForDrain(res)
        }
    } finally {
        clearInterval(keepalive)
        res.off('close', stop)
        stop()
        res.end()
    }
    return
}
```

Read the `logs` case as it actually stands and copy its `finally` block verbatim rather than the sketch above, so the two cannot drift.

Use the same policy verb the deploy history already uses for `decide`; read the `deploys` (history) case and copy it, so watching and reading the history are gated identically.

- [ ] **Step 4: Run the suite**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/api/routes.ts hostd/src/api/routes.test.ts
git commit -m "Serve a running deploy on GET of the path POST starts it from"
```

---

### Task 8: The portal reaches hostd

**Files:**
- Create: `server/hostd/deployWatch.ts`, `server/hostd/deployWatch.test.ts`
- Create: `app/api/sites/[id]/deploy/route.ts`
- Modify: `server/hostd/relay.ts`, `server/hostd/relay.test.ts`

**Interfaces:**
- Consumes: the api route from Task 7.
- Produces: `openDeployStream(config, caller, id, environment, fetchImpl?): Promise<LogStream>` and `relayDeployWatch(deps, id, params): Promise<Response>`.

- [ ] **Step 1: Write the failing tests**

Create `server/hostd/deployWatch.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { openDeployStream } from './deployWatch'

const config = { url: 'http://hostd:8080', token: 'a'.repeat(32) }
const caller = { actor: 'admin', user: 'koda' } as const

describe('openDeployStream', () => {
    it('asks hostd for the environment on the deploy path, with the caller headers', async () => {
        const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
        await openDeployStream(config as never, caller as never, 'acme', 'live', fetchImpl as never)
        const [url, init] = fetchImpl.mock.calls[0]!
        expect(url).toBe('http://hostd:8080/projects/acme/live/deploy')
        expect((init as RequestInit).method ?? 'GET').toBe('GET')
    })

    it('refuses a project id that is not one, without asking hostd', async () => {
        const fetchImpl = vi.fn()
        const result = await openDeployStream(config as never, caller as never, '../etc', 'live', fetchImpl as never)
        expect(result.ok).toBe(false)
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('refuses an environment that is not live or test, without asking hostd', async () => {
        const fetchImpl = vi.fn()
        const result = await openDeployStream(config as never, caller as never, 'acme', 'staging' as never, fetchImpl as never)
        expect(result.ok).toBe(false)
        expect(fetchImpl).not.toHaveBeenCalled()
    })
})
```

Match the test framework and import style the neighbouring `logs.test.ts` actually uses; copy its idiom rather than the sketch above if it differs.

Append to `server/hostd/relay.test.ts` a test that `relayDeployWatch` answers `not-found` for a client who does not own the site, mirroring the existing `relayLogs` ownership test exactly.

- [ ] **Step 2: Run them and watch them fail**

Run the portal test command for those two files.
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write them**

Create `server/hostd/deployWatch.ts`, mirroring `logs.ts`:

```ts
// Opens the stream of a running deploy. The same shape as logs.ts and for the same reason: the portal
// proxies hostd's event stream rather than reading it, so the browser never holds a hostd token.

import type { Caller } from './actor'
import type { HostdConfig } from './config'
import type { LogStream } from './logs'

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/
const ENVIRONMENTS = ['live', 'test'] as const

export type EnvironmentName = (typeof ENVIRONMENTS)[number]

export async function openDeployStream(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: EnvironmentName,
    fetchImpl: typeof fetch = fetch,
): Promise<LogStream> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    if (!(ENVIRONMENTS as readonly string[]).includes(environment)) {
        return { ok: false, code: 'bad-request', message: 'no such environment' }
    }

    let response: Response
    try {
        response = await fetchImpl(`${config.url}/projects/${id}/${environment}/deploy`, {
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

The fetch block and the refusal mapping above are `logs.ts`'s, to the line. Two copies of that is one too many: as the first step of this task, lift them out of `logs.ts` into an exported helper there and call it from both, so a change to how hostd is addressed cannot reach one caller and miss the other. If that refactor turns out to touch more than the two files, leave `logs.ts` alone and say so in the commit rather than growing this task.

Add to `server/hostd/relay.ts`:

```ts
export async function relayDeployWatch(deps: RelayDeps, id: string, params: URLSearchParams): Promise<Response> {
    const environment = params.get('environment')
    if (environment !== 'live' && environment !== 'test') return problem('bad-request')

    // A client may only watch their own site. 404 rather than 403, so the portal does not confirm that a
    // project id exists to somebody with no business knowing.
    if (deps.clientId && !(await deps.assertOwned(deps.clientId, id))) return problem('not-found')

    const stream = await deps.openDeployStream(deps.config, deps.caller, id, environment)
    if (!stream.ok) return problem(stream.code)

    return new Response(stream.response.body, { status: 200, headers: streamHeaders() })
}
```

Use `relayLogs`'s own response construction verbatim for the headers rather than a new `streamHeaders()` if it does not already exist. Add `openDeployStream` to `RelayDeps`.

Create `app/api/sites/[id]/deploy/route.ts` as a copy of the logs route with `relayDeployWatch` and `openDeployStream` in place of the log pair, keeping the session and config handling identical.

- [ ] **Step 4: Run the portal tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/hostd/deployWatch.ts server/hostd/deployWatch.test.ts server/hostd/relay.ts server/hostd/relay.test.ts "app/api/sites/[id]/deploy/route.ts"
git commit -m "Proxy a running deploy's stream to the browser"
```

---

### Task 9: The column

**Files:**
- Create: `app/(portal)/portal/sites/[id]/deployLog.tsx`, `app/(portal)/portal/sites/[id]/deployLog.test.tsx`
- Modify: `app/(portal)/portal/sites/[id]/deployPanel.tsx`, `app/(portal)/portal/sites/[id]/site.module.css`

**Interfaces:**
- Consumes: `GET /api/sites/<id>/deploy?environment=<env>` from Task 8.
- Produces: `<DeployLog id={string} environment={'live' | 'test'} />`.

- [ ] **Step 1: Write the failing tests**

Create `app/(portal)/portal/sites/[id]/deployLog.test.tsx`. `logs.test.tsx` already drives a fake `EventSource` (jsdom has none, and `ui/testing/setup.ts` installs an inert one); this is the same trick, narrowed to one stream:

```tsx
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const { DeployLog } = await import('./deployLog')

class FakeSource {
    static made: FakeSource[] = []
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    closed = false
    private listeners: Record<string, Array<(event: Event) => void>> = {}

    constructor(readonly url: string) {
        FakeSource.made.push(this)
    }

    addEventListener(type: string, fn: (event: Event) => void): void {
        (this.listeners[type] ??= []).push(fn)
    }

    removeEventListener(): void {}
    close(): void { this.closed = true }
    open(): void { act(() => { this.onopen?.() }) }

    event(payload: { at: string, startedAt: string, kind: string, text: string }): void {
        const message = Object.assign(new Event('line'), { data: JSON.stringify(payload) })
        act(() => { for (const fn of this.listeners.line ?? []) fn(message) })
    }
}

const realEventSource = globalThis.EventSource

beforeEach(() => {
    FakeSource.made = []
    globalThis.EventSource = FakeSource as unknown as typeof EventSource
})

afterEach(() => {
    globalThis.EventSource = realEventSource
    vi.unstubAllGlobals()
})

const AT = '2026-09-23T05:00:00.000Z'
const LATER = '2026-09-23T06:00:00.000Z'
const open = () => FakeSource.made.filter(source => !source.closed)[0]!

describe('the deploy column', () => {
    it('asks for the environment it was given', () => {
        render(<DeployLog id="acme" environment="live" />)
        const url = new URL(open().url, 'http://portal.test')
        expect(url.pathname).toBe('/api/sites/acme/deploy')
        expect(url.searchParams.get('environment')).toBe('live')
    })

    // The narrative and the raw output are the two things on screen, and reading one as the other is the
    // whole of why the column is easier to follow than a wall of build text.
    it('shows a step and a line of output, and tells them apart', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'step', text: 'building' })
        open().event({ at: AT, startedAt: AT, kind: 'output', text: '#7 [4/9] RUN npm ci' })

        const step = screen.getByText('building')
        const output = screen.getByText('#7 [4/9] RUN npm ci')
        expect(step).toBeInTheDocument()
        expect(output).toBeInTheDocument()
        expect(step.className).not.toEqual(output.className)
    })

    // One stream carries a sequence of deploys, so the boundary is startedAt changing, not the stream
    // closing. Without this the next deploy's lines would append to the last one's.
    it('clears the column when a different deploy starts', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'step', text: 'the old deploy' })
        open().event({ at: LATER, startedAt: LATER, kind: 'step', text: 'the new deploy' })

        expect(screen.queryByText('the old deploy')).toBeNull()
        expect(screen.getByText('the new deploy')).toBeInTheDocument()
    })

    it('shows the outcome when the end event arrives', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        open().event({ at: AT, startedAt: AT, kind: 'end', text: 'deployed in 9s' })
        expect(screen.getByText('deployed in 9s')).toBeInTheDocument()
    })

    // A refusal arrives as an HTTP error before the stream ever opens, and EventSource does not hand over
    // the body, so the same endpoint is asked again plainly to get the relay's own message.
    it('says why when hostd refuses, instead of failing silently', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({ message: 'Deploying is not available for this site.' }),
            { status: 403, headers: { 'content-type': 'application/json' } },
        )))
        render(<DeployLog id="acme" environment="live" />)
        await act(async () => { open().onerror?.() })
        expect(await screen.findByText(/not available for this site/)).toBeInTheDocument()
    })

    it('keeps at most MAX_LINES lines, dropping the oldest', () => {
        render(<DeployLog id="acme" environment="live" />)
        open().open()
        for (let i = 0; i < MAX_LINES + 10; i += 1) {
            open().event({ at: AT, startedAt: AT, kind: 'output', text: `line ${i}` })
        }
        expect(screen.queryByText('line 0')).toBeNull()
        expect(screen.getByText(`line ${MAX_LINES + 9}`)).toBeInTheDocument()
    })
})
```

Export `MAX_LINES` from `deployLog.tsx` and import it in the test, so the last test cannot drift from the component.

- [ ] **Step 2: Run them and watch them fail**

Expected: FAIL, the component does not exist.

- [ ] **Step 3: Write the component**

`deployLog.tsx` is a client component. `logs.tsx` is the reference for the `EventSource` handling, and its order matters: it does **not** pre-flight. It opens the stream first, and only if the stream errors *before* it has opened does it ask the same endpoint again plainly, to get the relay's refusal document in the caller's own language. Follow that, not the other way round:

```tsx
'use client'

// The live deploy column. One stream per environment, not per deploy: it is a tail of this
// environment's deploy activity, so the poller starting the next one needs no reconnection and a reload
// mid-deploy picks up where it was. startedAt changing is the boundary between one deploy and the next.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import styles from './site.module.css'

// The same ceiling the container log view keeps, for the same reason.
export const MAX_LINES = 2000

type Event = { at: string, startedAt: string, kind: 'step' | 'output' | 'end', text: string }

function isEvent(value: unknown): value is Event {
    if (typeof value !== 'object' || value === null) return false
    const raw = value as Record<string, unknown>
    return typeof raw.text === 'string' && typeof raw.startedAt === 'string'
        && (raw.kind === 'step' || raw.kind === 'output' || raw.kind === 'end')
}

export function DeployLog({ id, environment }: { id: string, environment: 'live' | 'test' }) {
    const [lines, setLines] = useState<Event[]>([])
    const [problem, setProblem] = useState<string | null>(null)
    const startedAt = useRef<string | null>(null)
    const router = useRouter()

    useEffect(() => {
        let stopped = false
        const url = `/api/sites/${id}/deploy?environment=${environment}`
        const stream = new EventSource(url)

        stream.onopen = () => { if (!stopped) setProblem(null) }

        stream.addEventListener('line', event => {
            const raw: unknown = JSON.parse((event as MessageEvent<string>).data)
            if (!isEvent(raw) || stopped) return
            setLines(previous => {
                // A different deploy: replace rather than append, so one deploy's output never reads as
                // the tail of the one before it.
                const base = raw.startedAt === startedAt.current ? previous : []
                startedAt.current = raw.startedAt
                const next = [...base, raw]
                return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
            })
            // The history row is written when the deploy ends, so this is when it becomes worth re-reading.
            if (raw.kind === 'end') router.refresh()
        })

        stream.onerror = () => {
            if (stopped) return
            // EventSource does not hand over the body of an HTTP error, so ask plainly for the message.
            void fetch(url, { cache: 'no-store' }).then(async response => {
                if (stopped) return
                if (response.ok) {
                    await response.body?.cancel()
                    return
                }
                const body = await response.json().catch(() => ({})) as { message?: unknown }
                setProblem(typeof body.message === 'string' ? body.message : 'This deploy cannot be watched.')
            }).catch(() => {
                if (!stopped) setProblem('This deploy cannot be watched.')
            })
        }

        return () => {
            stopped = true
            stream.close()
        }
    }, [id, environment, router])

    return (
        <aside className={styles.deployLog} aria-label="Deploy output">
            {problem && <p className={styles.deployLogProblem}>{problem}</p>}
            {!problem && lines.length === 0 && <p className={styles.deployLogIdle}>Nothing has deployed yet.</p>}
            <ol className={styles.deployLogLines}>
                {lines.map((line, index) => (
                    <li key={`${line.at}-${index}`} className={styles[line.kind]}>{line.text}</li>
                ))}
            </ol>
        </aside>
    )
}
```

The three `styles[line.kind]` classes (`step`, `output`, `end`) go in `site.module.css` alongside the grid in the next step: `step` as the narrative, `output` monospaced and dimmer, `end` as the closing line. They must differ, because a test asserts a step and an output do not share a class name.

- [ ] **Step 4: Place it and lay it out**

In `site.module.css`:

```css
/* The Deploys tab is two columns on a wide screen and one on a narrow one. The column is always here,
   not only while a deploy runs: one that came and went would reflow the page twice per deploy, with the
   history moving under the operator's cursor both times. */
.deployLayout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-4);
}

@media (min-width: 900px) {
    .deployLayout {
        grid-template-columns: minmax(0, 1fr) 22rem;
    }
}
```

Use the spacing token this file already uses; read it first rather than inventing `--space-4`.

In `deployPanel.tsx`, wrap the existing content and the new column in that grid, passing the project id and the open environment.

- [ ] **Step 5: Run everything**

Run the portal tests, then `cd hostd && npm test && npm run typecheck`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "app/(portal)/portal/sites/[id]/deployLog.tsx" "app/(portal)/portal/sites/[id]/deployLog.test.tsx" "app/(portal)/portal/sites/[id]/deployPanel.tsx" "app/(portal)/portal/sites/[id]/site.module.css"
git commit -m "Show a deploy as it happens, beside its history"
```

---

### Task 10: The runbook, and proving it on the dedi

**Files:**
- Modify: `hostd/RUNBOOK.md`

- [ ] **Step 1: Write the runbook paragraph**

Beside the existing **How one happens** passage in the deploy section:

```markdown
**Watching one.** The Deploys tab carries a column showing what the deploy is doing: its own phase lines,
with `docker compose` output beneath the build step. It is there whether or not a deploy is running, and
when none is it shows what the last one printed, until the next one starts. A deploy the poller started
is watchable exactly like one somebody pressed, and a reload mid-deploy picks up where it was, because
what a watcher attaches to is a buffer rather than a live pipe. Nothing of it is written to disk: an
agent restart loses the buffer, and loses the deploy with it, since a deploy is an in-process promise.
The history stays the durable record.
```

- [ ] **Step 2: Commit**

```bash
git add hostd/RUNBOOK.md
git commit -m "Say in the runbook how to watch a deploy"
```

- [ ] **Step 3: Prove it against a real deploy**

This is the step no test can stand in for. On the dedi:

```bash
cd /var/www/horizons && git pull --ff-only && ./scripts/stack.sh up --build hostd
```

Then open the Deploys tab for `backroom` and press Deploy now. Confirm, by watching:

1. Phase lines appear as they happen, not in one burst at the end.
2. Build output appears beneath the build step while the build is running.
3. The column shows what the deploy printed after it ends, and is still showing it on a reload.
4. A second browser tab opened mid-deploy shows everything from the beginning, not a fragment.
5. The history row appears when the deploy ends without a manual refresh.

If output arrives in one lump rather than line by line, stop: the spike says it should not, so something
between `createSpawnRunner` and the browser is buffering, and the place to look is the SSE write path and
any proxy in front of the portal (`x-accel-buffering: no` is already set for this reason).

---

## Self-review

**Spec coverage.** Event model, Task 1. Runner sink, Task 2. Buffer with replay, retention and bounds, Task 3. The two wraps and `record.output` unchanged, Task 4. The verb, Task 5. The widened `Outcome` and the handler, Task 6. The route, the policy and the keepalive, Task 7. The portal proxy, Task 8. The column, the idle state, the `startedAt` boundary, `MAX_LINES`, the refusal path and the layout, Task 9. Runbook and the live check, Task 10. The spec's "what this deliberately does not do" needs no task by definition.

**Types.** `DeployEvent` and `MAX_WATCH_BYTES` are defined in Task 1 and used under those names in Tasks 3, 4 and 6. `DeployWatch`'s methods are defined in Task 3 and called under those names in Tasks 4 and 6. `openDeployStream` and `relayDeployWatch` are defined in Task 8 and used in its own route. `DeployLog`'s props are defined in Task 9 and used in the same task.

**Known soft spots**, where the plan tells the implementer to read the neighbouring code rather than trusting a sketch: the exact `refusalOf` and `request` helper shapes in the hostd tests, the portal's test framework idiom, `logs.ts`'s header and error-mapping helpers, and the spacing token in `site.module.css`. Each is called out in the step that needs it. They are places where copying an existing idiom is right and inventing a second one is wrong.
