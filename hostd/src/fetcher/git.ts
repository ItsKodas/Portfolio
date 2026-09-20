// Git, as a set of argument lists and one runner. Every value is validated by fetch-protocol before it
// arrives, and `--` separates options from arguments everywhere a value could otherwise look like one.

import { tail, type Runner } from '../agent/compose.ts'
import type { Commit, FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

export const GIT_TIMEOUT_MS = 300_000
// Bytes that cannot appear in a subject, author name or timestamp, so splitting on them is unambiguous.
const FIELD = '\x1f'
const RECORD = '\x1e'

export const cloneArgv = (repo: string, dir: string, branch: string) =>
    ['clone', '--branch', branch, '--single-branch', '--', repo, dir]
export const fetchArgv = (dir: string) => ['-C', dir, 'fetch', '--prune', '--', 'origin']
export const checkoutArgv = (dir: string, worktree: string, commit: string) =>
    ['-C', dir, 'worktree', 'add', '--detach', '--force', worktree, commit]
export const logArgv = (dir: string, branch: string, limit: number) =>
    ['-C', dir, 'log', `--max-count=${limit}`, `--format=%h${FIELD}%s${FIELD}%an${FIELD}%aI${RECORD}`, `origin/${branch}`, '--']
export const tipArgv = (dir: string, branch: string) => ['-C', dir, 'rev-parse', `origin/${branch}`, '--']
const headArgv = (dir: string) => ['-C', dir, 'rev-parse', 'HEAD', '--']

export function parseLog(stdout: string): Commit[] {
    return stdout.split(RECORD).map(record => record.trim()).filter(Boolean).map(record => {
        const [commit, subject, author, at] = record.split(FIELD)
        return { commit: commit ?? '', subject: subject ?? '', author: author ?? '', at: at ?? '' }
    })
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
        case 'fetch': return fetchArgv(request.dir)
        case 'checkout': return checkoutArgv(request.dir, request.worktree, request.commit)
        case 'log': return logArgv(request.dir, request.branch, request.limit)
        case 'tip': return tipArgv(request.dir, request.branch)
    }
}

export async function runGit(request: FetchRequest, run: Runner): Promise<FetchReply> {
    const { verb } = request
    const result = await run('git', argvFor(request), GIT_TIMEOUT_MS)
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
    }
}
