// Git, as a set of argument lists and one runner. Every value is validated by fetch-protocol before it
// arrives, and options are separated from arguments everywhere a value could otherwise look like one:
// with `--` for the commands that take paths, and with `--verify --end-of-options` for rev-parse, which
// treats a trailing `--` as one more thing to echo (see tipArgv).

import { tail, type Runner } from '../agent/compose.ts'
import type { Commit, FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

// A bad or revoked token must fail as soon as the network round trip says so, not sit out the full
// GIT_TIMEOUT_MS waiting on a stdin prompt this container has no terminal to answer. Set once, at import
// time, since every git run here goes through the same createSpawnRunner, whose own allowlist (see
// DOCKER_ENV_KEYS in ../agent/compose.ts) is what actually carries this into the child's environment.
process.env.GIT_TERMINAL_PROMPT = '0'

export const GIT_TIMEOUT_MS = 300_000
// Bytes that cannot appear in a subject, author name or timestamp, so splitting on them is unambiguous.
const FIELD = '\x1f'
const RECORD = '\x1e'
// A bound on how many branch names a branches request answers, the same kind of cap MAX_LOG_LIMIT puts on
// a log request in fetch-protocol.ts: this is output from something outside this machine (the remote's
// own refs), and ls-remote has no --max-count of its own to ask it for fewer up front.
export const MAX_BRANCHES = 500

export const cloneArgv = (repo: string, dir: string, branch: string) =>
    ['clone', '--branch', branch, '--single-branch', '--', repo, dir]
// A branch, when the caller names one, becomes an explicit refspec: a --single-branch clone (what
// cloneArgv makes) configures a refspec for that one branch, so after a branch switch a plain fetch
// would never create refs/remotes/origin/<new branch> and tipArgv below would fail on a ref that does
// not exist. Naming it on the command line overrides the configured refspec for this run only.
export const fetchArgv = (dir: string, branch: string | null) => [
    '-C', dir, 'fetch', '--prune', '--', 'origin',
    ...(branch ? [`+refs/heads/${branch}:refs/remotes/origin/${branch}`] : []),
]
export const checkoutArgv = (dir: string, worktree: string, commit: string) =>
    ['-C', dir, 'worktree', 'add', '--detach', '--force', worktree, commit]
export const logArgv = (dir: string, branch: string, limit: number) =>
    ['-C', dir, 'log', `--max-count=${limit}`, `--format=%h${FIELD}%s${FIELD}%an${FIELD}%aI${RECORD}`, `origin/${branch}`, '--']
// The two rev-parse reads, and the one place in this file where a trailing `--` is wrong. rev-parse
// echoes back every argument it does not consume as a revision, so `git rev-parse origin/main --` answers
// two lines: the sha, then `--`. That second line rode out of here inside the commit, and the checkout
// the deploy ran next refused it against GIT_COMMIT ("commit is malformed"), after the history had
// already recorded the sha it starts with. `--end-of-options` on its own is echoed exactly the same way;
// `--verify` is what confines the output to the single revision asked for, and is what lets
// `--end-of-options` stand in for the separation the bare `--` was there to provide.
export const tipArgv = (dir: string, branch: string) =>
    ['-C', dir, 'rev-parse', '--verify', '--end-of-options', `origin/${branch}`]
const headArgv = (dir: string) => ['-C', dir, 'rev-parse', '--verify', '--end-of-options', 'HEAD']
// No dir: this asks the remote directly, so it needs nothing cloned yet. Reads the same way a clone or a
// fetch does (the token already lives in git's global credential.helper, set once at fetcher boot), so an
// ssh-style or an https repo both work exactly as they do for those verbs.
export const branchesArgv = (repo: string) => ['ls-remote', '--heads', '--', repo]

export function parseLog(stdout: string): Commit[] {
    return stdout.split(RECORD).map(record => record.trim()).filter(Boolean).map(record => {
        const [commit, subject, author, at] = record.split(FIELD)
        return { commit: commit ?? '', subject: subject ?? '', author: author ?? '', at: at ?? '' }
    })
}

// `git ls-remote --heads` answers one line per ref: a sha, a tab, then refs/heads/<name>. Only that shape
// is read as a branch; anything else (a blank line, a tag someone still matched) is skipped rather than
// guessed at. Capped at MAX_BRANCHES, because this is the remote's own output, not this machine's.
export function parseBranches(stdout: string): string[] {
    const names: string[] = []
    for (const line of stdout.split('\n')) {
        if (names.length >= MAX_BRANCHES) break
        const match = /^\S+\trefs\/heads\/(.+)$/.exec(line.trim())
        if (match) names.push(match[1]!)
    }
    return names
}

// Strips anything that could carry a credential: a userinfo section in a URL, or a bare token, so a
// remote's own error text can never put a secret into an audit entry.
function redact(text: string): string {
    return text
        .replace(/:\/\/[^@\s]+@/g, '://***@')
        .replace(/ghp_[A-Za-z0-9]+/g, '***')
        .replace(/github_pat_[A-Za-z0-9_]+/g, '***')
}

function argvFor(request: FetchRequest): string[] {
    switch (request.verb) {
        case 'clone': return cloneArgv(request.repo, request.dir, request.branch)
        case 'fetch': return fetchArgv(request.dir, request.branch)
        case 'checkout': return checkoutArgv(request.dir, request.worktree, request.commit)
        case 'log': return logArgv(request.dir, request.branch, request.limit)
        case 'tip': return tipArgv(request.dir, request.branch)
        case 'branches': return branchesArgv(request.repo)
    }
}

// Every repository under /var/www belongs to the operator (uid 1000), not root, because these are the
// operator's own checkouts and hostd must never take ownership of them: chowning them to root to make
// git happy is exactly the kind of fix that has already taken this machine down once, when a writer left
// a file root-only and a container running as someone else could no longer read it (see own's own
// comment in agent/index.ts). Git's own answer to a root process running against a directory it does not
// own is to refuse outright: "detected dubious ownership in repository at '<dir>'", which is exactly
// what stopped this container's first deploy on the live server, against a repository the operator had
// cloned by hand. `-c safe.directory=<dir>`, scoped to the one invocation
// and the one directory the caller (the agent, which only ever names trees under /var/www) actually
// asked this command to operate on, is deliberately narrower than a persisted, machine-wide
// `git config --global --add safe.directory '*'`: it never trusts anything beyond what this single git
// call was already going to touch, it needs no static list of repositories (sites are enrolled and
// created long after this process boots, so no such list could be complete anyway), and it leaves
// nothing behind in root's global gitconfig once the call returns. clone and branches never need it:
// clone's destination does not exist yet, so there is nothing yet for git to call dubious, and branches
// (`git ls-remote`) never touches a local directory at all.
function safeDirectoryArgs(request: FetchRequest): string[] {
    switch (request.verb) {
        case 'fetch': case 'checkout': case 'log': case 'tip':
            return ['-c', `safe.directory=${request.dir}`]
        case 'clone': case 'branches':
            return []
    }
}

export async function runGit(request: FetchRequest, run: Runner): Promise<FetchReply> {
    const { verb } = request
    const result = await run('git', [...safeDirectoryArgs(request), ...argvFor(request)], GIT_TIMEOUT_MS)
    if (result.timedOut) return { ok: false, code: 'failed', message: `git ${verb} timed out` }
    if (result.exitCode !== 0) return { ok: false, code: 'failed', message: redact(tail(result.stderr) || tail(result.stdout)) }

    switch (verb) {
        case 'clone': {
            const head = await run('git', headArgv(request.dir), GIT_TIMEOUT_MS)
            if (head.timedOut) return { ok: false, code: 'failed', message: 'git clone timed out' }
            if (head.exitCode !== 0) return { ok: false, code: 'failed', message: redact(tail(head.stderr) || tail(head.stdout)) }
            return { ok: true, commit: head.stdout.trim() }
        }
        case 'checkout':
            return { ok: true, commit: request.commit }
        case 'tip':
            return { ok: true, commit: result.stdout.trim() }
        case 'log':
            return { ok: true, commits: parseLog(result.stdout) }
        case 'fetch':
            return { ok: true }
        case 'branches':
            return { ok: true, branches: parseBranches(result.stdout) }
    }
}
