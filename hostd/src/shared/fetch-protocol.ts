// The fetcher's own protocol. Structured exactly like protocol.ts: one JSON request line, one switch on
// the verb, an onlyKeys guard per verb, and every field validated before it is read. The fetcher runs
// Git on the caller's behalf without a network of its own reaching anywhere but the remote it is told,
// so a path or option smuggled through a field here is the only way in.

import { isRecord } from './formats.ts'
import { CREDENTIAL_NAME, GIT_COMMIT, GIT_REF, GIT_REPO } from './registry.ts'
// Every path the caller may hand Git: a flat tree or sibling, or a nested site's repository,
// environment, or next and prev copy (see layout.ts). Nothing else reaches Git.
import { FETCH_DIR } from './layout.ts'

const MAX_LOG_LIMIT = 500

export type FetchRequest =
    // credential names which of the fetcher's tokens to authenticate with. null is the default
    // GITHUB_TOKEN, which is every project with no credential key in the registry.
    | { verb: 'clone', repo: string, dir: string, branch: string, credential: string | null }
    | { verb: 'fetch', dir: string, branch: string | null, credential: string | null }
    | { verb: 'checkout', dir: string, worktree: string, commit: string }
    // Re-points git's record of a worktree at where that tree actually is now. A deploy's swap renames
    // <dir>.next to <dir>, and git goes on recording the path the worktree was created at: a later
    // `git worktree prune` then sees a registered path that no longer exists and deletes the admin
    // directory <dir>/.git points at, leaving the live site's tree with no repository at all.
    | { verb: 'repair', dir: string, worktree: string }
    | { verb: 'log', dir: string, branch: string, limit: number }
    | { verb: 'tip', dir: string, branch: string }
    // No dir: this reads the remote directly (git ls-remote --heads), which needs nothing on disk. A
    // project can have a repo and have never been deployed, so there may be no clone to read branches
    // out of, and the remote's branches right now are also a better answer than whatever an old clone
    // last fetched.
    | { verb: 'branches', repo: string, credential: string | null }
    // Which credential names the fetcher actually holds. Names only: a token value never leaves this
    // container, and this answer is what fills the portal's Account select.
    | { verb: 'credentials' }

export type Commit = { commit: string, subject: string, author: string, at: string }

export type FetchReply =
    | { ok: true, commit?: string, commits?: Commit[], branches?: string[], credentials?: string[] }
    | { ok: false, code: 'bad-request' | 'failed' | 'unavailable', message: string }

type Parsed = { ok: true, request: FetchRequest } | FetchReply

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

function refuse(message: string): { ok: false, code: 'bad-request', message: string } {
    return { ok: false, code: 'bad-request', message }
}

function dirOf(raw: Record<string, unknown>, field: string): string | null {
    const value = raw[field]
    return typeof value === 'string' && FETCH_DIR.test(value) ? value : null
}

function branchOf(raw: Record<string, unknown>): string | null {
    const value = raw.branch
    return typeof value === 'string' && GIT_REF.test(value) ? value : null
}

// Names the rejected value when it was at least a string, so a caller (and an audit log) can see
// which branch was refused, not just that some branch was.
function branchRefusal(raw: Record<string, unknown>): { ok: false, code: 'bad-request', message: string } {
    const value = raw.branch
    return refuse(typeof value === 'string' ? `branch ${value} is malformed` : 'branch is malformed')
}

// A credential name is read exactly as far as a name: it becomes part of a file path in the fetcher, so
// anything but the registry's own grammar is refused here, before it is ever joined to one.
function credentialOf(raw: Record<string, unknown>): { ok: true, credential: string | null } | { ok: false, code: 'bad-request', message: string } {
    if (raw.credential === undefined || raw.credential === null) return { ok: true, credential: null }
    if (typeof raw.credential === 'string' && CREDENTIAL_NAME.test(raw.credential)) return { ok: true, credential: raw.credential }
    return refuse(typeof raw.credential === 'string' ? `credential ${raw.credential} is malformed` : 'credential is malformed')
}

export function parseFetchRequest(line: string): Parsed {
    let raw: unknown
    try {
        raw = JSON.parse(line)
    } catch {
        return refuse('request is not JSON')
    }
    if (!isRecord(raw)) return refuse('request must be a JSON object')

    switch (raw.verb) {
        case 'clone': {
            if (!onlyKeys(raw, ['verb', 'repo', 'dir', 'branch', 'credential'])) return refuse('clone takes only repo, dir, branch and credential')
            if (typeof raw.repo !== 'string' || !GIT_REPO.test(raw.repo)) return refuse('repo must be an ssh or https git URL')
            const dir = dirOf(raw, 'dir')
            if (!dir) return refuse('dir must be a folder directly under /var/www')
            const branch = branchOf(raw)
            if (!branch) return branchRefusal(raw)
            const credential = credentialOf(raw)
            if (!credential.ok) return credential
            return { ok: true, request: { verb: 'clone', repo: raw.repo, dir, branch, credential: credential.credential } }
        }

        case 'fetch': {
            if (!onlyKeys(raw, ['verb', 'dir', 'branch', 'credential'])) return refuse('fetch takes only dir, branch and credential')
            const dir = dirOf(raw, 'dir')
            if (!dir) return refuse('dir must be a folder directly under /var/www')
            const credential = credentialOf(raw)
            if (!credential.ok) return credential
            // Optional: without a branch this is an ordinary fetch of whatever the clone already tracks.
            // With one it becomes an explicit refspec in git.ts, because cloneArgv clones
            // --single-branch, which writes a refspec covering that one branch only: after a branch
            // switch a plain fetch would never create the remote-tracking ref the new tip is read from.
            if (raw.branch === undefined || raw.branch === null) return { ok: true, request: { verb: 'fetch', dir, branch: null, credential: credential.credential } }
            const branch = branchOf(raw)
            if (!branch) return branchRefusal(raw)
            return { ok: true, request: { verb: 'fetch', dir, branch, credential: credential.credential } }
        }

        case 'checkout': {
            if (!onlyKeys(raw, ['verb', 'dir', 'worktree', 'commit'])) return refuse('checkout takes only dir, worktree and commit')
            const dir = dirOf(raw, 'dir')
            if (!dir) return refuse('dir must be a folder directly under /var/www')
            const worktree = dirOf(raw, 'worktree')
            if (!worktree) return refuse('worktree must be a folder directly under /var/www')
            if (typeof raw.commit !== 'string' || !GIT_COMMIT.test(raw.commit)) return refuse('commit is malformed')
            return { ok: true, request: { verb: 'checkout', dir, worktree, commit: raw.commit } }
        }

        case 'repair': {
            if (!onlyKeys(raw, ['verb', 'dir', 'worktree'])) return refuse('repair takes only dir and worktree')
            const dir = dirOf(raw, 'dir')
            if (!dir) return refuse('dir must be a folder directly under /var/www')
            const worktree = dirOf(raw, 'worktree')
            if (!worktree) return refuse('worktree must be a folder directly under /var/www')
            return { ok: true, request: { verb: 'repair', dir, worktree } }
        }

        case 'log': {
            if (!onlyKeys(raw, ['verb', 'dir', 'branch', 'limit'])) return refuse('log takes only dir, branch and limit')
            const dir = dirOf(raw, 'dir')
            if (!dir) return refuse('dir must be a folder directly under /var/www')
            const branch = branchOf(raw)
            if (!branch) return branchRefusal(raw)
            const limit = raw.limit
            if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
                return refuse(`limit must be a whole number from 1 to ${MAX_LOG_LIMIT}`)
            }
            return { ok: true, request: { verb: 'log', dir, branch, limit } }
        }

        case 'tip': {
            if (!onlyKeys(raw, ['verb', 'dir', 'branch'])) return refuse('tip takes only dir and branch')
            const dir = dirOf(raw, 'dir')
            if (!dir) return refuse('dir must be a folder directly under /var/www')
            const branch = branchOf(raw)
            if (!branch) return branchRefusal(raw)
            return { ok: true, request: { verb: 'tip', dir, branch } }
        }

        case 'branches': {
            if (!onlyKeys(raw, ['verb', 'repo', 'credential'])) return refuse('branches takes only repo and credential')
            // Validated exactly as clone's repo is: the same grammar, checked the same way, because this
            // is the same value trusted the same distance, just without a dir to clone it into.
            if (typeof raw.repo !== 'string' || !GIT_REPO.test(raw.repo)) return refuse('repo must be an ssh or https git URL')
            const credential = credentialOf(raw)
            if (!credential.ok) return credential
            return { ok: true, request: { verb: 'branches', repo: raw.repo, credential: credential.credential } }
        }

        case 'credentials': {
            if (!onlyKeys(raw, ['verb'])) return refuse('credentials takes no other keys')
            return { ok: true, request: { verb: 'credentials' } }
        }

        default:
            return refuse('unknown verb')
    }
}
