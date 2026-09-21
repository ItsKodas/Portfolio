import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { branchesArgv, cloneArgv, checkoutArgv, fetchArgv, parseBranches, parseLog, runGit, MAX_BRANCHES } from './git.ts'
import type { Runner, RunResult } from '../agent/compose.ts'

const ok: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false }

function recorder(results: RunResult[] = [ok]) {
    const runs: string[][] = []
    let index = 0
    const run: Runner = async (command, args) => {
        runs.push([command, ...args])
        return results[Math.min(index++, results.length - 1)]!
    }
    return { run, runs }
}

// Must-exist, per the whole-branch review: a bad or revoked token must fail as soon as the network round
// trip says so, not sit out the full GIT_TIMEOUT_MS waiting on a stdin prompt this container has no
// terminal to answer. Set at import time (this file already imported git.ts above), and carried into the
// actual git child by compose.ts's own DOCKER_ENV_KEYS allowlist, which is what createSpawnRunner uses.
describe('credential prompt suppression', () => {
    it('disables the terminal credential prompt for every git run', () => {
        assert.equal(process.env.GIT_TERMINAL_PROMPT, '0')
    })
})

describe('argv', () => {
    it('clones one branch, without running repo hooks or prompting', () => {
        assert.deepEqual(cloneArgv('git@github.com:a/b.git', '/var/www/b', 'main'),
            ['clone', '--branch', 'main', '--single-branch', '--', 'git@github.com:a/b.git', '/var/www/b'])
    })

    it('fetches everything the clone tracks when no branch is named', () => {
        assert.deepEqual(fetchArgv('/var/www/b.git', null), ['-C', '/var/www/b.git', 'fetch', '--prune', '--', 'origin'])
    })

    it('fetches an explicit refspec for a named branch, which a --single-branch clone would otherwise never see', () => {
        assert.deepEqual(fetchArgv('/var/www/b.git', 'develop'), [
            '-C', '/var/www/b.git', 'fetch', '--prune', '--', 'origin', '+refs/heads/develop:refs/remotes/origin/develop',
        ])
    })

    it('checks a commit out into a separate tree without touching the original', () => {
        assert.deepEqual(checkoutArgv('/var/www/b', '/var/www/b.next', 'a1b2c3d'),
            ['-C', '/var/www/b', 'worktree', 'add', '--detach', '--force', '/var/www/b.next', 'a1b2c3d'])
    })

    it('lists a remote\'s branches with no dir: this reads the remote directly, nothing on disk', () => {
        assert.deepEqual(branchesArgv('git@github.com:a/b.git'), ['ls-remote', '--heads', '--', 'git@github.com:a/b.git'])
    })
})

describe('parseBranches', () => {
    it('reads the branch names out of ls-remote --heads, dropping the shas', () => {
        const stdout = 'a1b2c3d4\trefs/heads/main\n9d8c7b6a\trefs/heads/feature/thing\n'
        assert.deepEqual(parseBranches(stdout), ['main', 'feature/thing'])
    })

    it('returns nothing for empty output', () => {
        assert.deepEqual(parseBranches(''), [])
    })

    it('ignores a line that is not a refs/heads ref', () => {
        assert.deepEqual(parseBranches('a1b2c3d4\trefs/tags/v1\nb2c3d4e5\trefs/heads/main\n'), ['main'])
    })

    it('bounds how many names it returns: this is output from something outside this machine', () => {
        const lines = Array.from({ length: MAX_BRANCHES + 50 }, (_, i) => `${'a'.repeat(8)}\trefs/heads/branch-${i}`)
        assert.equal(parseBranches(lines.join('\n')).length, MAX_BRANCHES)
    })
})

describe('parseLog', () => {
    it('reads the record-separated format back into commits', () => {
        const stdout = 'a1b2c3d\x1fAdd the thing\x1fKoda\x1f2026-09-20T01:00:00Z\x1e9d8c7b6\x1fFix it\x1fKoda\x1f2026-09-19T01:00:00Z\x1e'
        assert.deepEqual(parseLog(stdout), [
            { commit: 'a1b2c3d', subject: 'Add the thing', author: 'Koda', at: '2026-09-20T01:00:00Z' },
            { commit: '9d8c7b6', subject: 'Fix it', author: 'Koda', at: '2026-09-19T01:00:00Z' },
        ])
    })

    it('copes with a subject containing newlines and separators', () => {
        assert.deepEqual(parseLog('a1b2c3d\x1fone\ntwo\x1fKoda\x1f2026-09-20T01:00:00Z\x1e'),
            [{ commit: 'a1b2c3d', subject: 'one\ntwo', author: 'Koda', at: '2026-09-20T01:00:00Z' }])
    })

    it('returns nothing for empty output', () => {
        assert.deepEqual(parseLog(''), [])
    })
})

describe('runGit', () => {
    it('reports the commit it cloned', async () => {
        const { run, runs } = recorder([ok, { ...ok, stdout: 'a1b2c3d4e5f6\n' }])
        const reply = await runGit({ verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main' }, run)
        assert.deepEqual(reply, { ok: true, commit: 'a1b2c3d4e5f6' })
        assert.equal(runs[0]![1], 'clone')
    })

    it('reports a failure with git\'s message, not a stack', async () => {
        const { run } = recorder([{ exitCode: 128, stdout: '', stderr: 'fatal: repository not found', timedOut: false }])
        const reply = await runGit({ verb: 'fetch', dir: '/var/www/b', branch: null }, run)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'fatal: repository not found' })
    })

    it('never puts the token in a message', async () => {
        const { run } = recorder([{ exitCode: 128, stdout: '', stderr: 'fatal: https://x-access-token:ghp_secret@github.com/a/b.git not found', timedOut: false }])
        const reply = await runGit({ verb: 'fetch', dir: '/var/www/b', branch: null }, run)
        assert.equal(reply.ok, false)
        assert.ok(!JSON.stringify(reply).includes('ghp_secret'))
    })

    it('calls a timeout what it is', async () => {
        const { run } = recorder([{ exitCode: null, stdout: '', stderr: '', timedOut: true }])
        const reply = await runGit({ verb: 'fetch', dir: '/var/www/b', branch: null }, run)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'git fetch timed out' })
    })

    it('answers the branch names for a branches request', async () => {
        const { run, runs } = recorder([{ ...ok, stdout: 'a1b2c3d4\trefs/heads/main\nb2c3d4e5\trefs/heads/develop\n' }])
        const reply = await runGit({ verb: 'branches', repo: 'git@github.com:a/b.git' }, run)
        assert.deepEqual(reply, { ok: true, branches: ['main', 'develop'] })
        assert.deepEqual(runs[0], ['git', 'ls-remote', '--heads', '--', 'git@github.com:a/b.git'])
    })

    it('reports a branches failure with git\'s message, not a stack, and never a credential', async () => {
        const { run } = recorder([{ exitCode: 128, stdout: '', stderr: 'fatal: https://x-access-token:ghp_secret@github.com/a/b.git: not found', timedOut: false }])
        const reply = await runGit({ verb: 'branches', repo: 'https://github.com/a/b.git' }, run)
        assert.equal(reply.ok, false)
        assert.ok(!JSON.stringify(reply).includes('ghp_secret'))
    })
})
