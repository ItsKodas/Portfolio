import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { cloneArgv, checkoutArgv, parseLog, runGit } from './git.ts'
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

describe('argv', () => {
    it('clones one branch, without running repo hooks or prompting', () => {
        assert.deepEqual(cloneArgv('git@github.com:a/b.git', '/var/www/b', 'main'),
            ['clone', '--branch', 'main', '--single-branch', '--', 'git@github.com:a/b.git', '/var/www/b'])
    })

    it('checks a commit out into a separate tree without touching the original', () => {
        assert.deepEqual(checkoutArgv('/var/www/b', '/var/www/b.next', 'a1b2c3d'),
            ['-C', '/var/www/b', 'worktree', 'add', '--detach', '--force', '/var/www/b.next', 'a1b2c3d'])
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
        const reply = await runGit({ verb: 'fetch', dir: '/var/www/b' }, run)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'fatal: repository not found' })
    })

    it('never puts the token in a message', async () => {
        const { run } = recorder([{ exitCode: 128, stdout: '', stderr: 'fatal: https://x-access-token:ghp_secret@github.com/a/b.git not found', timedOut: false }])
        const reply = await runGit({ verb: 'fetch', dir: '/var/www/b' }, run)
        assert.equal(reply.ok, false)
        assert.ok(!JSON.stringify(reply).includes('ghp_secret'))
    })

    it('calls a timeout what it is', async () => {
        const { run } = recorder([{ exitCode: null, stdout: '', stderr: '', timedOut: true }])
        const reply = await runGit({ verb: 'fetch', dir: '/var/www/b' }, run)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'git fetch timed out' })
    })
})
