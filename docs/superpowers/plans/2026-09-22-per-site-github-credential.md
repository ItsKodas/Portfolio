# Per-site GitHub credential Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project name which GitHub token the fetcher uses for it, so sites whose repositories live on a second GitHub account can be cloned, polled and listed.

**Architecture:** The registry holds a credential *name* only. Token values are added to `hostd/.env.fetcher` as `GITHUB_TOKEN_<NAME>` and never leave the fetcher container. At boot the fetcher writes one 0600 credential file per name; each git run that reaches GitHub is given `-c credential.helper= -c credential.helper=store --file=<that file>`, so exactly one token is reachable per invocation. The name travels portal to api to agent to fetcher; the value travels nowhere.

**Tech Stack:** TypeScript on Node 22 (hostd, tested with `node:test`), Next.js 15 App Router (portal, tested with vitest and Testing Library), YAML for the registry, git's `credential-store` helper.

**Spec:** `docs/superpowers/specs/2026-09-22-per-site-github-credential-design.md`

## Global Constraints

- No em dashes (U+2014 or `&mdash;`) anywhere: page copy, UI text, docs, commit messages, PR descriptions. Comments in code are the only exception. Use a comma, colon, full stop or parentheses. (`CLAUDE.md`)
- Credential names match `^[a-z0-9_]{1,32}$`. The env key for a name is `GITHUB_TOKEN_` plus the name uppercased.
- A token value may never appear in argv, in a log line, in the status file, in an audit entry, or anywhere in api, the agent or the portal. Only `hostd/src/fetcher/` may hold one.
- hostd tests: `cd hostd && npm test`. One file: `cd hostd && node --import tsx --test src/<path>.test.ts`.
- hostd typecheck: `cd hostd && npm run typecheck`.
- Portal tests, from the repo root: `npx vitest run "<path>"`.
- Commit at the end of every task. Do not push; the operator opens the PR.
- Follow the surrounding comment style: these files explain *why*, often with the incident that caused the rule. Match that density, do not exceed it.

---

### Task 1: The registry accepts a `credential` key

**Files:**
- Modify: `hostd/src/shared/registry.ts`
- Test: `hostd/src/shared/registry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export const CREDENTIAL_NAME: RegExp` (`/^[a-z0-9_]{1,32}$/`) and `ProjectEntry.credential: string | null`. Every later task imports one or both.

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/shared/registry.test.ts`, after the existing `repo` tests:

```ts
// The name of a token in .env.fetcher, not a token. The grammar is exactly what an environment
// variable suffix can spell once uppercased, which is why capitals and dashes are refused here
// rather than quietly lowercased into a key the operator never wrote.
describe('credential', () => {
    it('takes a name of lowercase letters, digits and underscores', () => {
        const registry = parseRegistry(project({ repo: 'git@github.com:a/b.git', credential: 'acme_2' }))
        assert.equal(registry.projects.get('site')?.credential, 'acme_2')
    })

    it('is null when absent, which is what says "use the default GITHUB_TOKEN"', () => {
        const registry = parseRegistry(project({ repo: 'git@github.com:a/b.git' }))
        assert.equal(registry.projects.get('site')?.credential, null)
    })

    it('refuses a name no env key could spell', () => {
        assert.match(invalidReason(project({ repo: 'git@github.com:a/b.git', credential: 'Acme-1' })) ?? '',
            /credential must be 1 to 32 lowercase letters/)
    })

    it('refuses a credential on a project with no repo to use it on', () => {
        assert.match(invalidReason(project({ credential: 'acme' })) ?? '', /credential needs repo/)
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/shared/registry.test.ts`
Expected: FAIL, four tests, `credential` reported as `unknown key credential`.

- [ ] **Step 3: Implement**

In `hostd/src/shared/registry.ts`:

Beside `GIT_REPO`, add the grammar:

```ts
// The name of a token the fetcher holds, never a token. Lowercase only, because the fetcher finds it as
// GITHUB_TOKEN_<NAME uppercased> and a name that needed case-folding to match would be a name the
// operator cannot read off their own env file.
export const CREDENTIAL_NAME = /^[a-z0-9_]{1,32}$/
```

Add `credential: string | null` to `ProjectEntry`, directly under `repo`. Add `'credential'` to `PROJECT_KEYS`. Add the parser beside `parseRepo`:

```ts
function parseCredential(raw: unknown, problems: string[]): string | null {
    if (raw === undefined) return null
    if (typeof raw === 'string' && CREDENTIAL_NAME.test(raw)) return raw
    problems.push('credential must be 1 to 32 lowercase letters, digits or underscores')
    return null
}
```

In `parseProject`, beside `const repo = parseRepo(...)`:

```ts
const credential = parseCredential(raw.credential, problems)
```

Beside the existing `branch needs repo` check:

```ts
if (!repo && credential) problems.push('credential needs repo')
```

And add `credential` to the returned entry, next to `repo`:

```ts
id, client, name, repo, credential, dir, compose, composePaths, upstream, portEnv, limits, environments,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && node --import tsx --test src/shared/registry.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: clean. `ProjectEntry` gained a required field, so any place that builds one by hand will fail here; fix those by adding `credential: null`.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/shared/registry.ts hostd/src/shared/registry.test.ts
git commit -m "Let a project name the credential it fetches with"
```

---

### Task 2: The registry writer sets and clears `credential`

**Files:**
- Modify: `hostd/src/shared/registry-write.ts`
- Test: `hostd/src/shared/registry-write.test.ts`

**Interfaces:**
- Consumes: `CREDENTIAL_NAME`, `ProjectEntry.credential` (Task 1).
- Produces: `Change` of kind `configure` accepts `credential?: string | null`; `ProjectDraft` accepts `credential?: string | null`.

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/shared/registry-write.test.ts`:

```ts
describe('configure credential', () => {
    it('writes the name onto the entry', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', credential: 'acme' })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')?.credential, 'acme')
    })

    // null deletes the key, exactly as it does for repo: back to the default GITHUB_TOKEN.
    it('deletes the key on null, rather than writing an empty one', () => {
        const set = applyChange(BASE, { kind: 'configure', id: 'acme', credential: 'acme' })
        assert.ok(set.ok)
        const cleared = applyChange(set.text, { kind: 'configure', id: 'acme', credential: null })
        assert.ok(cleared.ok)
        assert.equal(parseRegistry(cleared.text).projects.get('acme')?.credential, null)
        assert.ok(!cleared.text.includes('credential'))
    })

    it('leaves the key alone when the change does not mention it', () => {
        const set = applyChange(BASE, { kind: 'configure', id: 'acme', credential: 'acme' })
        assert.ok(set.ok)
        const other = applyChange(set.text, { kind: 'configure', id: 'acme', capabilities: ['lifecycle'] })
        assert.ok(other.ok)
        assert.equal(parseRegistry(other.text).projects.get('acme')?.credential, 'acme')
    })

    // The writer never decides what a name may be: it writes, re-parses with parseRegistry, and hands
    // back that validator's own words. Two copies of the grammar would drift.
    it('refuses a malformed name in the validator\'s words, and writes nothing', () => {
        const result = applyChange(BASE, { kind: 'configure', id: 'acme', credential: 'Acme-1' })
        assert.ok(!result.ok)
        assert.match(result.problem, /credential must be 1 to 32 lowercase letters/)
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/shared/registry-write.test.ts`
Expected: FAIL, TypeScript refuses `credential` on the `configure` change.

- [ ] **Step 3: Implement**

In `hostd/src/shared/registry-write.ts`, add the field to the `configure` member of `Change`, under `repo`:

```ts
        repo?: string | null
        credential?: string | null
```

Add it to `ProjectDraft`, under `repo`:

```ts
    repo: string
    credential?: string | null
```

In `edit`'s `add-project` case, between `repo` and `services`:

```ts
                repo: change.project.repo,
                ...(change.project.credential ? { credential: change.project.credential } : {}),
                services: change.project.services,
```

In `edit`'s `configure` case, directly after the `change.repo` block:

```ts
            if (change.credential !== undefined) {
                if (change.credential === null) doc.deleteIn(['projects', change.id, 'credential'])
                else doc.setIn(['projects', change.id, 'credential'], change.credential)
            }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && node --import tsx --test src/shared/registry-write.test.ts`
Expected: PASS, including the existing comment-preservation tests.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/registry-write.ts hostd/src/shared/registry-write.test.ts
git commit -m "Write a project's credential name into the registry"
```

---

### Task 3: The fetcher reads named tokens out of its environment

**Files:**
- Modify: `hostd/src/fetcher/credentials.ts`
- Test: `hostd/src/fetcher/credentials.test.ts`

**Interfaces:**
- Consumes: `CREDENTIAL_NAME` (Task 1).
- Produces:
  - `export const DEFAULT_CREDENTIAL_FILE = '/root/.git-credentials'`
  - `export function credentialFile(name: string): string`
  - `export function readCredentials(env: Record<string, string | undefined>): { tokens: Map<string, string>, problems: string[] }`
  - `export function credentialArgs(name: string | null): string[]`

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/fetcher/credentials.test.ts`:

```ts
describe('readCredentials', () => {
    it('reads every GITHUB_TOKEN_<NAME> as a named token, lowercasing the name', () => {
        const { tokens, problems } = readCredentials({ GITHUB_TOKEN: 'default', GITHUB_TOKEN_ACME: 'a', GITHUB_TOKEN_NORTHWIND: 'n' })
        assert.deepEqual(problems, [])
        assert.deepEqual([...tokens], [['acme', 'a'], ['northwind', 'n']])
    })

    // The default token is not a named one: it has no suffix, and every project without a credential
    // key already reaches it through the global helper.
    it('leaves GITHUB_TOKEN itself out of the named list', () => {
        const { tokens } = readCredentials({ GITHUB_TOKEN: 'default' })
        assert.equal(tokens.size, 0)
    })

    // Loud, not skipped: a name that is silently ignored surfaces days later as a deploy that cannot
    // read a repository, with nothing anywhere saying why.
    it('reports a suffix that is not a name this registry could ever hold', () => {
        const { problems } = readCredentials({ GITHUB_TOKEN_Acme: 'a' })
        assert.deepEqual(problems, ['GITHUB_TOKEN_Acme is not a credential name: use capitals, digits and underscores'])
    })

    it('reports an empty value rather than writing a credential file with no token in it', () => {
        const { problems } = readCredentials({ GITHUB_TOKEN_ACME: '' })
        assert.deepEqual(problems, ['GITHUB_TOKEN_ACME is empty'])
    })
})

describe('credentialArgs', () => {
    // The empty first value is the whole point. git reads credential.helper as a LIST and tries the
    // entries in config order, with command-line -c entries last, so without the reset the global
    // helper written at boot answers first and the DEFAULT token is used against the other account:
    // silently succeeding on a public repo, silently failing on a private one, with no wrong-token
    // error anywhere to read. Nothing else in this change can regress this quietly.
    it('resets the helper list before naming its own, so the global default cannot answer first', () => {
        assert.deepEqual(credentialArgs('acme'), [
            '-c', 'credential.helper=',
            '-c', 'credential.helper=store --file=/root/.git-credentials.acme',
        ])
    })

    it('adds nothing at all for the default credential, leaving the global helper in charge', () => {
        assert.deepEqual(credentialArgs(null), [])
    })
})
```

Add the new names to the file's existing import:

```ts
import { credentialArgs, credentialLine, readCredentials } from './credentials.ts'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/fetcher/credentials.test.ts`
Expected: FAIL, `readCredentials` and `credentialArgs` are not exported.

- [ ] **Step 3: Implement**

Append to `hostd/src/fetcher/credentials.ts`:

```ts
import { CREDENTIAL_NAME } from '../shared/registry.ts'

// Where git's "store" helper reads the default token from, and where each named one goes beside it. Named
// explicitly with --file everywhere rather than relied on via $HOME, so the location never depends on how
// the container sets that variable.
export const DEFAULT_CREDENTIAL_FILE = '/root/.git-credentials'
export const credentialFile = (name: string) => `${DEFAULT_CREDENTIAL_FILE}.${name}`

const PREFIX = 'GITHUB_TOKEN_'

// Every GITHUB_TOKEN_<NAME> in the environment, as name to token. A malformed suffix or an empty value
// is a problem rather than a skip: the fetcher refuses to boot on one, the same way it already refuses
// to boot without GITHUB_TOKEN at all.
export function readCredentials(env: Record<string, string | undefined>): { tokens: Map<string, string>, problems: string[] } {
    const tokens = new Map<string, string>()
    const problems: string[] = []
    for (const key of Object.keys(env).sort()) {
        if (!key.startsWith(PREFIX) || key === 'GITHUB_TOKEN') continue
        const suffix = key.slice(PREFIX.length)
        const name = suffix.toLowerCase()
        if (suffix !== suffix.toUpperCase() || !CREDENTIAL_NAME.test(name)) {
            problems.push(`${key} is not a credential name: use capitals, digits and underscores`)
            continue
        }
        const token = env[key]
        if (!token) {
            problems.push(`${key} is empty`)
            continue
        }
        tokens.set(name, token)
    }
    return { tokens, problems }
}

// git treats credential.helper as a list and tries its entries in config order, with command-line -c
// entries last. The empty value first is what CLEARS that list, so the global helper set at boot (the
// default token) cannot answer ahead of the one named here. Without it a project on a second account
// would be fetched with the wrong token and told nothing about it.
export function credentialArgs(name: string | null): string[] {
    return name === null ? [] : ['-c', 'credential.helper=', '-c', `credential.helper=store --file=${credentialFile(name)}`]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && node --import tsx --test src/fetcher/credentials.test.ts`
Expected: PASS, including the two pre-existing `credentialLine` tests.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/fetcher/credentials.ts hostd/src/fetcher/credentials.test.ts
git commit -m "Read named GitHub tokens out of the fetcher's environment"
```

---

### Task 4: The fetcher writes one credential file per named token

**Files:**
- Modify: `hostd/src/fetcher/credentials.ts` (takes `writeCredentials` over from `index.ts`)
- Modify: `hostd/src/fetcher/index.ts`
- Test: `hostd/src/fetcher/credentials.test.ts`

**Interfaces:**
- Consumes: `readCredentials`, `credentialFile`, `DEFAULT_CREDENTIAL_FILE`, `credentialLine` (Task 3).
- Produces: `export async function writeCredentials(default_: string, tokens: Map<string, string>, run: Runner, fs: CredentialFs): Promise<void>` and `export type CredentialFs = { writeFile(path: string, text: string, mode: number): Promise<void>, chmod(path: string, mode: number): Promise<void> }`.

`writeCredentials` moves out of `index.ts` for the reason already written at the top of `credentials.ts`: `index.ts` runs the whole fetcher the moment it is imported, so nothing in it can be tested. Behaviour for the default token is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/fetcher/credentials.test.ts`:

```ts
function fakeFs() {
    const written: Array<{ path: string, text: string, mode: number }> = []
    const chmodded: Array<{ path: string, mode: number }> = []
    const fs = {
        writeFile: async (path: string, text: string, mode: number) => { written.push({ path, text, mode }) },
        chmod: async (path: string, mode: number) => { chmodded.push({ path, mode }) },
    }
    return { fs, written, chmodded }
}

function fakeRunner() {
    const runs: string[][] = []
    const run: Runner = async (command, args) => {
        runs.push([command, ...args])
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }
    return { run, runs }
}

describe('writeCredentials', () => {
    it('writes the default token where the global helper reads it, as it always has', async () => {
        const { fs, written } = fakeFs()
        const { run, runs } = fakeRunner()
        await writeCredentials('default', new Map(), run, fs)

        assert.deepEqual(written, [{ path: '/root/.git-credentials', text: credentialLine('default'), mode: 0o600 }])
        assert.deepEqual(runs[0], ['git', 'config', '--global', 'credential.helper', 'store --file=/root/.git-credentials'])
        assert.deepEqual(runs[1], ['git', 'config', '--global', 'url.https://github.com/.insteadOf', 'git@github.com:'])
    })

    it('writes one file per named token, beside the default and just as private', async () => {
        const { fs, written } = fakeFs()
        const { run } = fakeRunner()
        await writeCredentials('default', new Map([['acme', 'a']]), run, fs)

        assert.deepEqual(written[1], { path: '/root/.git-credentials.acme', text: credentialLine('a'), mode: 0o600 })
    })

    // Only the default is ever made global. A named file is reached by the -c pair credentialArgs
    // builds, per invocation, which is what keeps one git run from reaching another account's token.
    it('makes no global config for a named token', async () => {
        const { fs } = fakeFs()
        const { run, runs } = fakeRunner()
        await writeCredentials('default', new Map([['acme', 'a']]), run, fs)

        assert.ok(!runs.some(argv => argv.join(' ').includes('.git-credentials.acme')))
    })

    it('throws when git config fails, so boot stops rather than running without a helper', async () => {
        const { fs } = fakeFs()
        const run: Runner = async () => ({ exitCode: 1, stdout: '', stderr: 'nope', timedOut: false })
        await assert.rejects(() => writeCredentials('default', new Map(), run, fs), /credential.helper failed/)
    })
})
```

Add to the imports at the top of the test file:

```ts
import { writeCredentials } from './credentials.ts'
import type { Runner } from '../agent/compose.ts'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/fetcher/credentials.test.ts`
Expected: FAIL, `writeCredentials` is not exported from `credentials.ts`.

- [ ] **Step 3: Implement**

Append to `hostd/src/fetcher/credentials.ts`:

```ts
import type { Runner } from '../agent/compose.ts'

const GIT_CONFIG_TIMEOUT_MS = 10_000

// Only the parts of node:fs/promises this needs, so a test can watch what was written without touching
// a disk. The mode is passed to writeFile AND re-applied with chmod, because writeFile's mode is only
// honoured when it is the call that creates the file.
export type CredentialFs = {
    writeFile(path: string, text: string, mode: number): Promise<void>
    chmod(path: string, mode: number): Promise<void>
}

// Puts each token where git itself will find it and never anywhere else: not a command-line argument (so
// it cannot appear in `ps`), not a log line, not the status file. The default token gets the global
// helper, exactly as before. A named token gets a file and nothing else: credentialArgs names it per
// invocation, which is what keeps one git run from reaching another account's token.
//
// url.insteadOf is global and account-independent: it is what lets a registry entry go on giving its
// repo as an ssh-style URL and still be fetched over HTTPS, so no SSH key needs to exist here either.
export async function writeCredentials(
    default_: string, tokens: Map<string, string>, run: Runner, fs: CredentialFs,
): Promise<void> {
    await fs.writeFile(DEFAULT_CREDENTIAL_FILE, credentialLine(default_), 0o600)
    await fs.chmod(DEFAULT_CREDENTIAL_FILE, 0o600)
    for (const [name, token] of tokens) {
        await fs.writeFile(credentialFile(name), credentialLine(token), 0o600)
        await fs.chmod(credentialFile(name), 0o600)
    }

    const helper = await run('git', ['config', '--global', 'credential.helper', `store --file=${DEFAULT_CREDENTIAL_FILE}`], GIT_CONFIG_TIMEOUT_MS)
    if (helper.exitCode !== 0) throw new Error(`git config credential.helper failed: ${helper.stderr || helper.stdout}`)

    const insteadOf = await run('git', ['config', '--global', 'url.https://github.com/.insteadOf', 'git@github.com:'], GIT_CONFIG_TIMEOUT_MS)
    if (insteadOf.exitCode !== 0) throw new Error(`git config url.insteadOf failed: ${insteadOf.stderr || insteadOf.stdout}`)
}
```

In `hostd/src/fetcher/index.ts`: delete the local `writeCredentials` function, the `CREDENTIAL_FILE` constant and the now-unused `GIT_CONFIG_TIMEOUT_MS` if nothing else uses it (the `git --version` check does, so keep it). Import the new pieces and read the named tokens in `main`:

```ts
import { readCredentials, writeCredentials, type CredentialFs } from './credentials.ts'

const credentialFs: CredentialFs = {
    writeFile: (path, text, mode) => writeFile(path, text, { mode }),
    chmod: (path, mode) => chmod(path, mode),
}
```

```ts
    const token = process.env.GITHUB_TOKEN ?? null
    const { tokens, problems } = readCredentials(process.env)
    const runner = createSpawnRunner()

    const failures: string[] = [...problems]
    if (!token) failures.push('GITHUB_TOKEN is not set')
```

```ts
    await writeCredentials(token as string, tokens, runner, credentialFs)
    if (tokens.size > 0) log(`holding ${tokens.size} named credential(s): ${[...tokens.keys()].join(', ')}`)
```

The log line names the names, never a value. Keep it that way.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && node --import tsx --test src/fetcher/credentials.test.ts && npm run typecheck`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/fetcher/credentials.ts hostd/src/fetcher/credentials.test.ts hostd/src/fetcher/index.ts
git commit -m "Write a credential file per named token, and make the writer testable"
```

---

### Task 5: The fetch protocol carries a credential name and answers a list

**Files:**
- Modify: `hostd/src/shared/fetch-protocol.ts`
- Test: `hostd/src/shared/fetch-protocol.test.ts`

**Interfaces:**
- Consumes: `CREDENTIAL_NAME` (Task 1).
- Produces: `clone`, `fetch` and `branches` requests each carry `credential: string | null`; a new `{ verb: 'credentials' }` request; `FetchReply` gains `credentials?: string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/shared/fetch-protocol.test.ts`:

```ts
describe('credential on the verbs that reach GitHub', () => {
    it('carries a name on a clone', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main', credential: 'acme' }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main', credential: 'acme' } })
    })

    it('carries a name on a fetch', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b', branch: 'main', credential: 'acme' }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'fetch', dir: '/var/www/b', branch: 'main', credential: 'acme' } })
    })

    it('carries a name on a branch listing, which reads the remote directly', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'branches', repo: 'git@github.com:a/b.git', credential: 'acme' }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'branches', repo: 'git@github.com:a/b.git', credential: 'acme' } })
    })

    // Absent means the default token, which is every project that has no credential key.
    it('reads an absent credential as null rather than refusing', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b', branch: null }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'fetch', dir: '/var/www/b', branch: null, credential: null } })
    })

    it('refuses a malformed name, naming it, before it can reach a file path', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b', branch: 'main', credential: '../../etc/x' }))
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'credential ../../etc/x is malformed' })
    })

    it('refuses a credential on a local-only verb, which has no remote to authenticate to', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'tip', dir: '/var/www/b', branch: 'main', credential: 'acme' }))
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'tip takes only dir and branch' })
    })
})

describe('the credentials verb', () => {
    it('takes nothing but the verb', () => {
        assert.deepEqual(parseFetchRequest(JSON.stringify({ verb: 'credentials' })), { ok: true, request: { verb: 'credentials' } })
    })

    it('refuses anything alongside it', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'credentials', repo: 'git@github.com:a/b.git' }))
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'credentials takes no other keys' })
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/shared/fetch-protocol.test.ts`
Expected: FAIL, `clone takes only repo, dir and branch` for the first three, `unknown verb` for the last two.

- [ ] **Step 3: Implement**

In `hostd/src/shared/fetch-protocol.ts`, add `CREDENTIAL_NAME` to the existing import from `./registry.ts`:

```ts
import { CREDENTIAL_NAME, GIT_COMMIT, GIT_REF, GIT_REPO } from './registry.ts'
```

Change the request union:

```ts
export type FetchRequest =
    // credential names which of the fetcher's tokens to authenticate with. null is the default
    // GITHUB_TOKEN, which is every project with no credential key in the registry.
    | { verb: 'clone', repo: string, dir: string, branch: string, credential: string | null }
    | { verb: 'fetch', dir: string, branch: string | null, credential: string | null }
    | { verb: 'checkout', dir: string, worktree: string, commit: string }
    | { verb: 'log', dir: string, branch: string, limit: number }
    | { verb: 'tip', dir: string, branch: string }
    | { verb: 'branches', repo: string, credential: string | null }
    // Which credential names the fetcher actually holds. Names only: a token value never leaves this
    // container, and this answer is what fills the portal's Account select.
    | { verb: 'credentials' }
```

Add to `FetchReply`'s ok member: `credentials?: string[]`.

Add the reader beside `branchOf`:

```ts
// A credential name is read exactly as far as a name: it becomes part of a file path in the fetcher, so
// anything but the registry's own grammar is refused here, before it is ever joined to one.
function credentialOf(raw: Record<string, unknown>): { ok: true, credential: string | null } | { ok: false, code: 'bad-request', message: string } {
    if (raw.credential === undefined || raw.credential === null) return { ok: true, credential: null }
    if (typeof raw.credential === 'string' && CREDENTIAL_NAME.test(raw.credential)) return { ok: true, credential: raw.credential }
    return refuse(typeof raw.credential === 'string' ? `credential ${raw.credential} is malformed` : 'credential is malformed')
}
```

In the `clone` case: add `'credential'` to `onlyKeys`, change the refusal text to `'clone takes only repo, dir, branch and credential'`, and before the return:

```ts
            const credential = credentialOf(raw)
            if (!credential.ok) return credential
            return { ok: true, request: { verb: 'clone', repo: raw.repo, dir, branch, credential: credential.credential } }
```

In the `fetch` case: add `'credential'` to `onlyKeys` and its refusal text, read `credentialOf(raw)` once before the two returns, and include `credential: credential.credential` in both (the branch-less one and the branch one).

In the `branches` case: add `'credential'` to `onlyKeys` and its refusal text, and include the credential in the return.

Add the new verb case:

```ts
        case 'credentials': {
            if (!onlyKeys(raw, ['verb'])) return refuse('credentials takes no other keys')
            return { ok: true, request: { verb: 'credentials' } }
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && node --import tsx --test src/shared/fetch-protocol.test.ts`
Expected: PASS. The typecheck will still fail elsewhere (callers do not pass `credential` yet); Task 6 and Task 9 fix that.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/fetch-protocol.ts hostd/src/shared/fetch-protocol.test.ts
git commit -m "Carry a credential name on the fetch verbs that reach GitHub"
```

---

### Task 6: The fetcher runs git with the named credential

**Files:**
- Modify: `hostd/src/fetcher/git.ts`
- Modify: `hostd/src/fetcher/index.ts`
- Test: `hostd/src/fetcher/git.test.ts`

**Interfaces:**
- Consumes: `credentialArgs` (Task 3), the new request shapes (Task 5).
- Produces: `runGit(request: FetchRequest, run: Runner, names: readonly string[]): Promise<FetchReply>`. The third argument is the credential names the fetcher holds, never the tokens.

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/fetcher/git.test.ts`:

```ts
describe('running git with a named credential', () => {
    it('puts the credential options ahead of everything, so git reads them as global options', async () => {
        const { run, runs } = recorder()
        await runGit({ verb: 'fetch', dir: '/var/www/b.git', branch: 'main', credential: 'acme' }, run, ['acme'])

        assert.deepEqual(runs[0], [
            'git',
            '-c', 'credential.helper=',
            '-c', 'credential.helper=store --file=/root/.git-credentials.acme',
            '-c', 'safe.directory=/var/www/b.git',
            '-C', '/var/www/b.git', 'fetch', '--prune', '--', 'origin', '+refs/heads/main:refs/remotes/origin/main',
        ])
    })

    it("adds nothing for the default credential, leaving today's global helper in charge", async () => {
        const { run, runs } = recorder()
        await runGit({ verb: 'branches', repo: 'git@github.com:a/b.git', credential: null }, run, ['acme'])

        assert.deepEqual(runs[0], ['git', 'ls-remote', '--heads', '--', 'git@github.com:a/b.git'])
    })

    // A name the fetcher does not hold is refused before git runs at all: git with a --file that does
    // not exist would fall through to no credential and fail with GitHub's authentication error, which
    // says nothing about the actual cause.
    it('refuses a name it does not hold, without running git', async () => {
        const { run, runs } = recorder()
        const reply = await runGit({ verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main', credential: 'nope' }, run, ['acme'])

        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'unknown credential nope' })
        assert.deepEqual(runs, [])
    })

    it('answers the credentials verb from its own names, sorted, without running git', async () => {
        const { run, runs } = recorder()
        const reply = await runGit({ verb: 'credentials' }, run, ['northwind', 'acme'])

        assert.deepEqual(reply, { ok: true, credentials: ['acme', 'northwind'] })
        assert.deepEqual(runs, [])
    })
})
```

Every existing `runGit` call in this file needs the third argument and the new `credential` field on clone, fetch and branches requests. Update them to `credential: null` and `[]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/fetcher/git.test.ts`
Expected: FAIL, `runGit` takes two arguments and does not know the `credentials` verb.

- [ ] **Step 3: Implement**

In `hostd/src/fetcher/git.ts`:

```ts
import { credentialArgs } from './credentials.ts'

// Everything except the credentials verb, which answers from the fetcher's own list and never runs git.
type GitRequest = Exclude<FetchRequest, { verb: 'credentials' }>
```

Change `argvFor` and `safeDirectoryArgs` to take `GitRequest` (their bodies do not change). Then:

```ts
export async function runGit(request: FetchRequest, run: Runner, names: readonly string[]): Promise<FetchReply> {
    // Answered from the names this fetcher was booted with. Names only: a token value never leaves this
    // container, and this is what the portal's Account select is drawn from.
    if (request.verb === 'credentials') return { ok: true, credentials: [...names].sort() }

    const credential = 'credential' in request ? request.credential : null
    // Before git runs, not after: a --file that does not exist makes git fall through to no credential
    // at all and fail with GitHub's own authentication error, which says nothing about the real cause.
    if (credential !== null && !names.includes(credential)) {
        return { ok: false, code: 'bad-request', message: `unknown credential ${credential}` }
    }

    const { verb } = request
    const result = await run('git', [...credentialArgs(credential), ...safeDirectoryArgs(request), ...argvFor(request)], GIT_TIMEOUT_MS)
    ...
}
```

The rest of the function is unchanged, except that the `switch (verb)` at the end now switches over `GitRequest['verb']` (the early return narrowed it), so no `credentials` case is needed or wanted there.

In `hostd/src/fetcher/index.ts`, hand the names to the handler:

```ts
    const names = [...tokens.keys()]
    const server = createServer(socket => {
        handleFetchConnection(socket, request => runGit(request, runner, names), log)
            .catch(error => log(`connection failed: ${describeError(error)}`))
    })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && node --import tsx --test src/fetcher/git.test.ts`
Expected: PASS, including every pre-existing argv test.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/fetcher/git.ts hostd/src/fetcher/git.test.ts hostd/src/fetcher/index.ts
git commit -m "Run git with the credential the request names"
```

---

### Task 7: The agent protocol carries the credential and the new verb

**Files:**
- Modify: `hostd/src/shared/protocol.ts`
- Test: `hostd/src/shared/protocol.test.ts`

**Interfaces:**
- Consumes: `CREDENTIAL_NAME` (Task 1).
- Produces: `ConfigureArgs.credential?: string | null`; `ProvisionCreateArgs.credential?: string`; `CredentialsRequest = { verb: 'credentials' }` in `AgentRequest`; `CredentialsReply = { ok: true, credentials: string[] }` in `AgentReply`.

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/shared/protocol.test.ts`:

```ts
describe('configure credential', () => {
    it('takes a name', () => {
        assert.deepEqual(parseConfigureArgs({ credential: 'acme' }), { credential: 'acme' })
    })

    // null is how the Settings form says "back to the default token", so it must survive the parse
    // rather than being dropped as absent: absent means "leave it alone".
    it('keeps a null, which clears the key, apart from an absent one, which leaves it alone', () => {
        assert.deepEqual(parseConfigureArgs({ credential: null }), { credential: null })
        assert.deepEqual(parseConfigureArgs({}), {})
    })

    it('refuses a malformed name', () => {
        const parsed = parseConfigureArgs({ credential: 'Acme-1' })
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'credential must be 1 to 32 lowercase letters, digits or underscores' })
    })
})

describe('the credentials verb', () => {
    it('is parsed with no project, like health', () => {
        assert.deepEqual(parseAgentRequest(JSON.stringify({ verb: 'credentials' })), { ok: true, request: { verb: 'credentials' } })
    })

    it('takes nothing else', () => {
        const parsed = parseAgentRequest(JSON.stringify({ verb: 'credentials', project: 'acme' }))
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'credentials takes no other keys' })
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/shared/protocol.test.ts`
Expected: FAIL, `configure takes only capabilities, repo, branches and domains`, and `unknown verb`.

- [ ] **Step 3: Implement**

In `hostd/src/shared/protocol.ts`, add `CREDENTIAL_NAME` to the import from `./registry.ts`.

`ConfigureArgs`, under `repo`:

```ts
    repo?: string | null
    // The name of one of the fetcher's tokens, never a token. null clears the key, which puts the
    // project back on the default GITHUB_TOKEN.
    credential?: string | null
```

`ProvisionCreateArgs`, under `repo`:

```ts
    repo: string
    // Optional, unlike repo: a project created without one uses the default token, which is every
    // project on the operator's own GitHub account.
    credential?: string
```

Add the request and reply types beside `BranchesRequest` and `BranchesReply`:

```ts
// Which credential names the fetcher holds, for the Settings form's Account select. No project: this is
// a fact about the machine, not about a site.
export type CredentialsRequest = { verb: 'credentials' }
export type CredentialsReply = { ok: true, credentials: string[] }
```

Add `CredentialsRequest` to `AgentRequest` (beside `HealthRequest`, not to `ProjectRequest`), and `CredentialsReply` to `AgentReply`. Add to `VERB_CAPABILITY`:

```ts
    // Null for the same reason branches is: it fills the Settings form, and api's policy is what makes
    // it admin-only.
    credentials: null,
```

In `parseConfigureArgs`, add `'credential'` to `onlyKeys` and update its refusal text to `'configure takes only capabilities, repo, credential, branches and domains'`. After the `repo` block:

```ts
    let credential: string | null | undefined
    if (raw.credential !== undefined) {
        if (raw.credential !== null && (typeof raw.credential !== 'string' || !CREDENTIAL_NAME.test(raw.credential))) {
            return refuse('bad-request', 'credential must be 1 to 32 lowercase letters, digits or underscores')
        }
        credential = raw.credential as string | null
    }
```

And in the returned object, after `repo`:

```ts
        ...(credential !== undefined ? { credential } : {}),
```

In `parseAgentRequest`, beside the `health` case:

```ts
        case 'credentials': {
            if (!onlyKeys(raw, ['verb'])) return refuse('bad-request', 'credentials takes no other keys')
            return { ok: true, request: { verb: 'credentials' } }
        }
```

Find where provision create args are parsed in this file and accept an optional `credential`, refusing anything that fails `CREDENTIAL_NAME` with the same message as above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && node --import tsx --test src/shared/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/protocol.ts hostd/src/shared/protocol.test.ts
git commit -m "Carry the credential name and the credentials verb on the agent protocol"
```

---

### Task 8: The agent lists credentials, uses one for branches, and validates one on configure

**Files:**
- Modify: `hostd/src/agent/agent.ts`
- Test: `hostd/src/agent/agent.test.ts`

**Interfaces:**
- Consumes: Tasks 5 and 7.
- Produces: the agent answers `{ verb: 'credentials' }`; `branches` sends the project's credential; `configure` refuses `no credential named <name>` before writing.

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/agent/agent.test.ts`, following the file's existing fake-fetcher and fake-writer setup:

```ts
describe('credentials', () => {
    it("answers the fetcher's list, with no project needed", async () => {
        const agent = makeAgent({ fetcher: fetcherAnswering({ ok: true, credentials: ['acme'] }) })
        const outcome = await agent.handle({ verb: 'credentials' })
        assert.deepEqual(replyOf(outcome), { ok: true, credentials: ['acme'] })
    })

    it('says so when there is no fetcher to ask', async () => {
        const agent = makeAgent({ fetcher: undefined })
        const outcome = await agent.handle({ verb: 'credentials' })
        assert.deepEqual(replyOf(outcome), { ok: false, code: 'unavailable', message: 'the fetcher is not configured' })
    })

    it("sends the project's own credential when listing branches", async () => {
        const { fetcher, calls } = recordingFetcher({ ok: true, branches: ['main'] })
        const agent = makeAgent({ fetcher, registry: registryWith({ credential: 'acme' }) })
        await agent.handle({ verb: 'branches', project: 'acme' })
        assert.deepEqual(calls, [{ verb: 'branches', repo: 'git@github.com:acme/site.git', credential: 'acme' }])
    })

    it("sends null for a project with no credential, which is the default token", async () => {
        const { fetcher, calls } = recordingFetcher({ ok: true, branches: ['main'] })
        const agent = makeAgent({ fetcher, registry: registryWith({}) })
        await agent.handle({ verb: 'branches', project: 'acme' })
        assert.deepEqual(calls, [{ verb: 'branches', repo: 'git@github.com:acme/site.git', credential: null }])
    })

    // Checked here, where the name is being SET, so the registry can never hold a name that cannot
    // work. Without this the save succeeds and the next deploy is what discovers the typo.
    it('refuses a configure naming a credential the fetcher does not hold, and writes nothing', async () => {
        const { fetcher } = recordingFetcher({ ok: true, credentials: ['acme'] })
        const { agent, writes } = makeAgentWithWriter({ fetcher })
        const outcome = await agent.handle({ verb: 'configure', project: 'acme', args: { credential: 'nope' } })
        assert.deepEqual(replyOf(outcome), { ok: false, code: 'bad-request', message: 'no credential named nope' })
        assert.deepEqual(writes, [])
    })

    it('does not ask the fetcher anything when the configure clears the credential', async () => {
        const { fetcher, calls } = recordingFetcher({ ok: true, credentials: ['acme'] })
        const { agent } = makeAgentWithWriter({ fetcher })
        await agent.handle({ verb: 'configure', project: 'acme', args: { credential: null } })
        assert.deepEqual(calls, [])
    })
})
```

Use the helpers this file already has for building an agent, a fake fetcher and a recording writer; the names above are placeholders for whatever those helpers are actually called. Read the top of `agent.test.ts` first and reuse them rather than adding new ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/agent/agent.test.ts`
Expected: FAIL on the unknown verb and the missing `credential` field.

- [ ] **Step 3: Implement**

In `hostd/src/agent/agent.ts`, in `handle`, beside the health line:

```ts
        if (request.verb === 'credentials') return reply(await this.credentials())
```

Add the method beside `branches`:

```ts
    // Names only, straight from the fetcher, which is the only process that knows which tokens it was
    // given. No project: this is a fact about the machine, and api's policy is what makes it the
    // operator's alone.
    private async credentials(): Promise<AgentReply> {
        if (!this.deps.fetcher) return refuse('unavailable', 'the fetcher is not configured')
        const result = await this.deps.fetcher.call({ verb: 'credentials' })
        if (!result.ok) return refuse(result.code === 'bad-request' ? 'bad-request' : 'failed', result.message)
        return { ok: true, credentials: result.credentials ?? [] }
    }
```

In `branches`, pass the entry's own credential (never the request's: a caller names a project and that is all it is trusted with):

```ts
        const result = await this.deps.fetcher.call({ verb: 'branches', repo: project.repo, credential: project.credential })
```

In `configure`, before the `this.deps.writer.write` call:

```ts
        // Validated where it is SET, not only where it is used: a name the fetcher does not hold would
        // otherwise sit in the registry until the next deploy discovered it. A null is clearing the key
        // and needs nothing checked, so the fetcher is not asked at all.
        if (args.credential) {
            const held = await this.credentials()
            if (!('credentials' in held)) return held
            if (!held.credentials.includes(args.credential)) {
                return refuse('bad-request', `no credential named ${args.credential}`)
            }
        }
```

And add the field to the write:

```ts
            ...(args.credential === undefined ? {} : { credential: args.credential }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && node --import tsx --test src/agent/agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/agent.ts hostd/src/agent/agent.test.ts
git commit -m "List credentials, list branches with one, and refuse a name nothing holds"
```

---

### Task 9: Deploys and provisioning use the project's credential

**Files:**
- Modify: `hostd/src/agent/deploy.ts:141`
- Modify: `hostd/src/agent/provision.ts:203-227`
- Test: `hostd/src/agent/deploy.test.ts`, `hostd/src/agent/provision.test.ts`

**Interfaces:**
- Consumes: Tasks 5 and 7.
- Produces: `ProvisionAttempt` gains `credential: string | null`. No new exports.

This is the task that makes the feature actually work. A site whose branches list correctly but whose poller still fetches with the default token looks configured and never deploys.

- [ ] **Step 1: Write the failing tests**

In `hostd/src/agent/deploy.test.ts`:

```ts
// The poller's own path. A project that clones with the right token and then polls with the wrong one
// looks provisioned and silently never deploys again, which is the failure this test exists for.
it("fetches the tip with the project's own credential", async () => {
    const { deps, calls } = depsWithRecordingFetcher({ ok: true, commit: 'a1b2c3d' })
    await currentTip({ ...project, credential: 'acme' }, environment, deps)

    assert.deepEqual(calls[0], { verb: 'fetch', dir: '/var/www/acme.git', branch: 'main', credential: 'acme' })
})

it('fetches with null for a project that has no credential', async () => {
    const { deps, calls } = depsWithRecordingFetcher({ ok: true, commit: 'a1b2c3d' })
    await currentTip({ ...project, credential: null }, environment, deps)

    assert.deepEqual(calls[0], { verb: 'fetch', dir: '/var/www/acme.git', branch: 'main', credential: null })
})
```

In `hostd/src/agent/provision.test.ts`:

```ts
it('clones a new project with the credential the create named', async () => {
    const { deps, calls } = depsWithRecordingFetcher()
    await createProject({ ...createArgs, credential: 'acme' }, deps)

    assert.equal(calls[0]?.credential, 'acme')
})

// The registry entry has to carry it too, or the first deploy after creation fetches with the default
// token and fails on a repository the clone could read.
it('writes the credential onto the new entry', async () => {
    const { deps, writes } = depsWithRecordingWriter()
    await createProject({ ...createArgs, credential: 'acme' }, deps)

    assert.equal(writes[0]?.project?.credential, 'acme')
})

it('clones a new environment with the credential the project already has', async () => {
    const { deps, calls } = depsWithRecordingFetcher()
    await addEnvironment({ ...project, credential: 'acme' }, addArgs, deps)

    assert.equal(calls[0]?.credential, 'acme')
})
```

Match the helper names these two files already use.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/agent/deploy.test.ts src/agent/provision.test.ts`
Expected: FAIL, the recorded calls have no `credential`.

- [ ] **Step 3: Implement**

In `hostd/src/agent/deploy.ts`, in `currentTip`:

```ts
        const fetched = await deps.fetcher.call({ verb: 'fetch', dir: trees.repo, branch, credential: project.credential })
```

`tip`, `log` and `checkout` are unchanged: they read local refs and reach nothing.

In `hostd/src/agent/provision.ts`, add `credential: string | null` to `ProvisionAttempt`, and:

```ts
        const cloned = await deps.fetcher.call({ verb: 'clone', repo: attempt.repo, dir, branch: attempt.branch, credential: attempt.credential })
```

In `createProject`, pass `credential: args.credential ?? null` into `provisionOnDisk`, and add `...(args.credential ? { credential: args.credential } : {})` to the `ProjectDraft` it writes. In `addEnvironment`, pass `credential: project.credential`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npm test`
Expected: PASS across the whole hostd suite. This is the first point at which every hostd caller of the fetch protocol compiles again.

- [ ] **Step 5: Typecheck**

Run: `cd hostd && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/agent/deploy.ts hostd/src/agent/provision.ts hostd/src/agent/deploy.test.ts hostd/src/agent/provision.test.ts
git commit -m "Deploy and provision with the project's own credential"
```

---

### Task 10: api serves the credential list and carries the name

**Files:**
- Modify: `hostd/src/api/routes.ts` (route table, `matchRoute`, the handler switch, the project listing, `parseCreate`)
- Test: `hostd/src/api/routes.test.ts`

**Interfaces:**
- Consumes: Tasks 7 and 8.
- Produces: `GET /credentials` answering `{ ok: true, credentials: string[] }`, admin only; `credential` on each project in `GET /projects` for an admin; `credential` accepted by `POST /projects` and `PUT /projects/:id/settings`.

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/api/routes.test.ts`:

```ts
describe('GET /credentials', () => {
    it('routes at the top level, not under a project, and allows only GET', () => {
        assert.deepEqual(matchRoute('GET', '/credentials'), { verb: 'credentials' })
        assert.equal(matchRoute('POST', '/credentials').verb, 'method-not-allowed')
    })

    it('asks the agent and answers its list', async () => {
        agent.reply = () => ({ ok: true, credentials: ['acme', 'northwind'] })
        const response = await request('/credentials', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, credentials: ['acme', 'northwind'] })
        assert.deepEqual(agent.calls, [{ verb: 'credentials' }])
    })

    // 403 rather than the 404 a project route gives: there is no project here to be coy about, and
    // this is gated the way audit-all is.
    it('refuses a client, and never calls the agent', async () => {
        const response = await request('/credentials')
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
    })
})

describe('the credential on a project', () => {
    it('carries a settings credential through to the agent, null included rather than dropped', async () => {
        agent.reply = () => ({ ok: true, output: 'configured' })
        const body = { credential: null }
        const response = await request('/projects/acme/settings', { method: 'PUT', actor: 'admin', body })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'configure', project: 'acme', args: body }])
    })

    // The operator sees the entry as it is; a client has no use for a name that means nothing to them
    // and everything to the machine, so it is absent rather than null, exactly as repo is.
    it('answers the credential to an admin and withholds it from a client', async () => {
        const forAdmin = await (await request('/projects', { actor: 'admin' })).json() as { projects: Array<Record<string, unknown>> }
        assert.ok(Object.hasOwn(forAdmin.projects[0]!, 'credential'))

        const forClient = await (await request('/projects')).json() as { projects: Array<Record<string, unknown>> }
        assert.ok(!Object.hasOwn(forClient.projects[0]!, 'credential'))
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/api/routes.test.ts`
Expected: FAIL, `/credentials` is `not-found`.

- [ ] **Step 3: Implement**

In `hostd/src/api/routes.ts`:

Add to the `Route` union, beside `{ verb: 'audit-all' }`:

```ts
    | { verb: 'credentials' }
```

In `matchRoute`, beside the `health` line:

```ts
    if (parts.length === 1 && parts[0] === 'credentials') return only('GET', { verb: 'credentials' })
```

In the handler switch, beside `audit-all`:

```ts
            case 'credentials': {
                // Gated like audit-all rather than through authorize: there is no project in this
                // question, so there is no ownership to decide. The list fills the Settings form, which
                // is the operator's alone end to end.
                if (caller.actor.kind !== 'admin') return refuseRoute(403, 'admin-only', 'only the admin can read the credential list', null, 'configure')
                const reply = await callAgent({ verb: 'credentials' })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, null, 'configure')
                return sendJson(res, 200, reply)
            }
```

Match the exact `refuseRoute` signature the `audit-all` case uses; the arguments above follow it.

In the project listing, extend the admin-only spread:

```ts
                        ...(caller.actor.kind === 'admin' ? { repo: project.repo, credential: project.credential } : {}),
```

In `parseCreate`, add `'credential'` to its `onlyKeys` list and its message, and validate it:

```ts
    if (value.credential !== undefined && (typeof value.credential !== 'string' || !CREDENTIAL_NAME.test(value.credential))) {
        return { ok: false, message: 'credential must be 1 to 32 lowercase letters, digits or underscores' }
    }
```

passing `...(value.credential === undefined ? {} : { credential: value.credential })` into the args it builds. Import `CREDENTIAL_NAME` from `../shared/registry.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/api/routes.ts hostd/src/api/routes.test.ts
git commit -m "Serve the credential list, and carry a project's credential name"
```

---

### Task 11: The portal's hostd client reads and writes the credential

**Files:**
- Create: `server/hostd/credentials.ts`
- Create: `server/hostd/credentials.test.ts`
- Modify: `server/hostd/settings.ts`, `server/hostd/projects.ts`
- Modify: `app/(portal)/portal/sites/[id]/site.ts`
- Test: `app/(portal)/portal/sites/[id]/site.test.ts`

**Interfaces:**
- Consumes: Task 10's `GET /credentials` and the `credential` field on a project.
- Produces: `listCredentials(config, caller, fetchImpl?): Promise<HostdResult<string[]>>`; `SiteSettings.credential?: string | null`; `Project.credential?: string | null`; the site view's `credential: string | null`.

- [ ] **Step 1: Write the failing test**

Create `server/hostd/credentials.test.ts`, modelled on `server/hostd/branches.test.ts` (reuse its `fakeFetch` helper and its `config` and `admin` fixtures):

```ts
import { describe, expect, it } from 'vitest'
import { listCredentials } from './credentials'

describe('listCredentials', () => {
    it("reads the machine's credential names, not a project's", async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, credentials: ['acme', 'northwind'] })
        const result = await listCredentials(config, admin, fetchImpl)

        expect(calls[0].url).toBe('http://hostd-api:8080/credentials')
        expect(result).toEqual({ ok: true, value: ['acme', 'northwind'] })
    })

    it("carries hostd's own refusal along rather than throwing", async () => {
        const { fetchImpl } = fakeFetch({ ok: false, code: 'admin-only', message: 'only the admin can read the credential list' }, 403)
        const result = await listCredentials(config, admin, fetchImpl)

        expect(result).toEqual({ ok: false, code: 'admin-only', message: 'only the admin can read the credential list' })
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/hostd/credentials.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

Create `server/hostd/credentials.ts`:

```ts
// The names of the GitHub tokens the fetcher holds, for the Settings tab's Account select. Names only:
// hostd never answers a token value to anything, and nothing here ever holds one.
//
// Machine level, not per project: which accounts exist is a fact about the dedi, and one project's
// Settings form offers exactly the same list as another's. Failure is ordinary here, not exceptional
// (hostd down, the fetcher down, a client asking): the caller decides what to show for that, and this
// module only carries hostd's own words along.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

export async function listCredentials(
    config: HostdConfig,
    caller: Caller,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<string[]>> {
    const result = await hostdRequest<{ credentials: string[] }>(config, caller, '/credentials', {}, fetchImpl)
    return result.ok ? { ok: true, value: result.value.credentials } : result
}
```

In `server/hostd/settings.ts`, add to `SiteSettings` under `repo`:

```ts
    // The name of one of the fetcher's tokens, never a token. null clears it, back to the default.
    credential?: string | null
```

In `server/hostd/projects.ts`, add to `Project` under `repo`:

```ts
    // Answered for the operator alone, like repo, so it is absent for a client rather than null
    credential?: string | null
```

In `app/(portal)/portal/sites/[id]/site.ts`, add `credential: string | null` to the view type beside `repo`, `credential: null` to each of the two fallback objects that already set `repo: null`, and `credential: project.credential ?? null` where the real one sets `repo: project.repo ?? null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/hostd/credentials.test.ts "app/(portal)/portal/sites/[id]/site.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/hostd/credentials.ts server/hostd/credentials.test.ts server/hostd/settings.ts server/hostd/projects.ts "app/(portal)/portal/sites/[id]/site.ts"
git commit -m "Read the credential list and a site's credential in the portal"
```

---

### Task 12: The Settings tab offers the Account select

**Files:**
- Modify: `app/(portal)/portal/sites/[id]/settings.tsx`
- Modify: `app/(portal)/portal/sites/[id]/actions.ts:163-172`
- Modify: `app/(portal)/portal/sites/[id]/page.tsx:246-261, 373-382`
- Test: `app/(portal)/portal/sites/[id]/settings.test.tsx`

**Interfaces:**
- Consumes: `listCredentials` and the view's `credential` (Task 11).
- Produces: `SiteSettingsForm` accepts `credential: string | null`, `credentials?: string[] | null`, `credentialsError?: string | null`.

- [ ] **Step 1: Write the failing tests**

Add to `app/(portal)/portal/sites/[id]/settings.test.tsx`:

```ts
const withCredentials = { ...props, credential: null, credentials: ['acme', 'northwind'], credentialsError: null }

describe('the account select', () => {
    it('offers the default and every name the fetcher holds', () => {
        render(<SiteSettingsForm {...withCredentials} />)
        const select = screen.getByRole('combobox', { name: /account/i })
        expect(select).toHaveValue('')
        expect(screen.getByRole('option', { name: /default/i })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'acme' })).toBeInTheDocument()
    })

    it('sends the chosen name on its own, leaving every other field alone', async () => {
        render(<SiteSettingsForm {...withCredentials} />)

        await userEvent.selectOptions(screen.getByRole('combobox', { name: /account/i }), 'acme')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { credential: 'acme' })
    })

    // Back to the default token, which has to be reachable: an operator who set the wrong account
    // would otherwise have to SSH into the dedi to undo it.
    it('sends null when the default is chosen again', async () => {
        render(<SiteSettingsForm {...withCredentials} credential="acme" />)

        await userEvent.selectOptions(screen.getByRole('combobox', { name: /account/i }), '')
        await userEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(saveSettingsAction).toHaveBeenCalledWith('arbysauto', { credential: null })
    })

    // The same rule the branch select learned: a saved value the list no longer has is still shown.
    // Dropping it would be this page rewriting the operator's configuration by rendering.
    it('still shows a saved name the fetcher no longer holds, and says what that means', () => {
        render(<SiteSettingsForm {...withCredentials} credential="gone" />)

        expect(screen.getByRole('combobox', { name: /account/i })).toHaveValue('gone')
        expect(screen.getByText(/no credential named "gone"/i)).toBeInTheDocument()
    })

    // Never blocks the field: hostd could not answer, the operator did nothing wrong.
    it('falls back to showing the saved name when the list could not be read', () => {
        render(<SiteSettingsForm {...props} credential="acme" credentials={null} credentialsError="hostd could not be reached." />)

        expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(portal)/portal/sites/[id]/settings.test.tsx"`
Expected: FAIL, there is no combobox named Account.

- [ ] **Step 3: Implement**

In `settings.tsx`, extend the props:

```ts
export function SiteSettingsForm({ id, capabilities, repo, credential, environments, branches = null, branchesError = null, credentials = null, credentialsError = null }: {
    ...
    credential: string | null
    // The credential names hostd holds, or null when there is no list to offer (hostd unreachable, or
    // the fetcher down). credentialsError says which, in hostd's own words.
    credentials?: string[] | null
    credentialsError?: string | null
})
```

Add state beside the repo state:

```ts
    const [credentialValue, setCredentialValue] = useState(credential ?? '')
```

In `save`, beside the repo diff:

```ts
    const nextCredential = credentialValue.trim() === '' ? null : credentialValue
```

and in the payload type and body:

```ts
    if (nextCredential !== credential) payload.credential = nextCredential
```

Render it under the Repo field, mirroring the branch select:

```tsx
            {credentials ? (
                <Field
                    as="select"
                    label="Account"
                    value={credentialValue}
                    onChange={event => setCredentialValue(event.target.value)}
                >
                    {/* The default token, and the way back to it. */}
                    <option value="">default (GITHUB_TOKEN)</option>
                    {credentials.map(name => <option key={name} value={name}>{name}</option>)}
                    {/* A saved name the fetcher no longer holds, kept for the same reason the branch
                        select keeps an unknown branch: swapping it for something on the list would be
                        this page rewriting the operator's configuration by rendering. */}
                    {notHeld && <option value={credentialValue}>{credentialValue}</option>}
                </Field>
            ) : (
                <Field label="Account" value={credentialValue} onChange={event => setCredentialValue(event.target.value)} />
            )}
            {notHeld && (
                <p className={styles.note}>
                    {`There is no credential named "${credentialValue}" on the host, so anything that reaches GitHub for this site will fail until one is added to .env.fetcher or another is chosen here.`}
                </p>
            )}
            {credentialsError && <p className={styles.note}>{`The host's credential names could not be read: ${credentialsError}`}</p>}
```

with, above the return:

```ts
    const notHeld = credentials !== null && credentialValue !== '' && !credentials.includes(credentialValue)
```

In `actions.ts`, add `credential` to `isSettings`:

```ts
    const { capabilities, repo, credential, branches, ...rest } = value as Record<string, unknown>
    if (Object.keys(rest).length > 0) return false
    if (capabilities !== undefined && !(Array.isArray(capabilities) && capabilities.every(one => typeof one === 'string'))) return false
    if (repo !== undefined && repo !== null && typeof repo !== 'string') return false
    if (credential !== undefined && credential !== null && typeof credential !== 'string') return false
```

In `page.tsx`, inside the block that already fetches branches for the Settings tab, fetch the credential list from the same caller and config (do not re-read either):

```ts
    let credentials: string[] | null = null
    let credentialsError: string | null = null
```

and in the branch where `who` exists:

```ts
            const held = await listCredentials(hostdConfig, who.caller)
            if (held.ok) credentials = held.value
            else credentialsError = held.message
```

with the same two fallbacks assigning `credentialsError` that the branch list assigns `branchesError`. Import `listCredentials` from `@/server/hostd/credentials`. Pass all three new props to `SiteSettingsForm`:

```tsx
                                    repo={view.repo}
                                    credential={view.credential}
                                    credentials={credentials}
                                    credentialsError={credentialsError}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run "app/(portal)/portal/sites/[id]"`
Expected: PASS, including every pre-existing settings test.

- [ ] **Step 5: Commit**

```bash
git add "app/(portal)/portal/sites/[id]/settings.tsx" "app/(portal)/portal/sites/[id]/settings.test.tsx" "app/(portal)/portal/sites/[id]/actions.ts" "app/(portal)/portal/sites/[id]/page.tsx"
git commit -m "Choose a site's GitHub account on the Settings tab"
```

---

### Task 13: Document adding an account, and verify the whole feature

**Files:**
- Modify: `hostd/example.env.fetcher`
- Modify: `hostd/RUNBOOK.md` (the setup section near line 28, the upgrade section near line 60, and the troubleshooting table near line 1140)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Write the example env file**

Append to `hostd/example.env.fetcher`:

```
# Further accounts, one per GitHub account whose repositories this machine deploys. The suffix is the
# name a project's `credential:` key gives in the registry, uppercased: GITHUB_TOKEN_ACME is `acme`.
# Capitals, digits and underscores only. The fetcher refuses to boot on anything else, or on an empty
# value, rather than leaving a site to fail its next deploy with nothing saying why.
#GITHUB_TOKEN_ACME=
```

- [ ] **Step 2: Write the runbook section**

Add a section to `hostd/RUNBOOK.md` near the fetcher setup step, matching the surrounding heading level and voice:

````markdown
### Adding a second GitHub account

A site whose repository lives under another GitHub account needs that account's own token. The token
value never leaves the dedi: the registry and the portal only ever hold its name.

1. On that account, create a fine-grained personal access token, read-only, limited to the repositories
   this machine deploys.
2. Add it to `hostd/.env.fetcher` as `GITHUB_TOKEN_<NAME>`, where `<NAME>` is capitals, digits and
   underscores (for example `GITHUB_TOKEN_ACME`).
3. Restart the fetcher: `docker compose up -d --force-recreate fetcher`. It refuses to boot on a
   malformed name or an empty value and says which variable is at fault, so check it came up:
   `docker compose logs --tail 20 fetcher`.
4. In the portal, open the site, go to Settings, and pick the account (the lowercased name, `acme`) in
   the Account field. Save.

The Account field offers exactly the names the fetcher answered with, and a name it does not hold is
refused on save rather than at the next deploy.
````

Add a row to the troubleshooting table:

```markdown
| `unknown credential <name>`, or `no credential named <name>` on a save | The registry names a credential `.env.fetcher` does not have. Add `GITHUB_TOKEN_<NAME>` there and restart the fetcher, or pick another account on the site's Settings tab. |
```

- [ ] **Step 3: Verify the whole feature**

Run, and read the output rather than assuming it:

```bash
cd hostd && npm test && npm run typecheck
```

```bash
npx vitest run
```

Expected: both green. If anything fails, fix it before the commit; do not report the feature complete on a failing suite.

- [ ] **Step 4: Check the writing rule**

Run: `python -c "import io,sys; [print(f'{f}:{i}') for f in sys.argv[1:] for i,l in enumerate(io.open(f,encoding='utf-8'),1) if chr(0x2014) in l]" hostd/RUNBOOK.md hostd/example.env.fetcher`
Expected: no matches. An em dash anywhere in this change, including commit messages, breaks `CLAUDE.md`.

- [ ] **Step 5: Commit**

```bash
git add hostd/example.env.fetcher hostd/RUNBOOK.md
git commit -m "Document adding a second GitHub account to the fetcher"
```

---

## Verification beyond the tests

The one thing no test in this plan can prove is that git itself honours the reset entry, because the
hostd Dockerfile runs `npm test` in the `base` stage and git is only installed in the `fetcher` stage
(the same reason `credentialLine` is pinned by shape rather than by shelling out). After deploying, on
the dedi, run this against a PRIVATE repository on the other account: a public one would list refs
whether or not the reset worked (git uses the first helper that answers, not the first that
authenticates), so only a private repo, unreadable by the default token, actually discriminates:

```bash
docker compose exec fetcher git -c credential.helper= -c 'credential.helper=store --file=/root/.git-credentials.acme' ls-remote --heads https://github.com/<the other account>/<private repo>.git
```

It should list refs. If it asks for a username or fails to authenticate, the credential file or the
token is wrong, not the plumbing above.
