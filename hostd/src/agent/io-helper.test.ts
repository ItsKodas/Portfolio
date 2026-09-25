import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createIoHelper, helperArgv, hostPathOf } from './io-helper.ts'
import type { Runner, RunResult } from './compose.ts'

const IMAGE = `sha256:${'c'.repeat(64)}`
const MOUNTS = [
    { Type: 'bind', Source: '/var/www', Destination: '/var/www' },
    { Type: 'bind', Source: '/srv/backups/hostd', Destination: '/backups' },
    { Type: 'volume', Source: '/var/lib/docker/volumes/hostd-agent-state/_data', Destination: '/var/lib/hostd' },
]
const INSPECT = JSON.stringify({ image: IMAGE, mounts: MOUNTS })

function recorder(results: Array<Partial<RunResult>>) {
    const calls: Array<{ command: string, args: string[], timeoutMs: number }> = []
    const runner: Runner = async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs })
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...(results.shift() ?? {}) }
    }
    return { runner, calls }
}

describe('helperArgv', () => {
    it('runs the command offline, read-only, with only the capabilities cp -a needs, and only the mounts given', () => {
        assert.deepEqual(helperArgv(IMAGE, 'hostd-io-1', [
            { source: '/var/www/acme/live', target: '/live', readOnly: true },
            { source: '/var/www/acme/.copy/abc/new', target: '/stage' },
        ], ['cp', '-a', '/live/storage', '/stage/storage']), [
            'run', '--rm', '--name', 'hostd-io-1', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
            '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--cap-add', 'FSETID',
            '--security-opt', 'no-new-privileges', '--pull', 'never', '--user', '0:0',
            '--mount', 'type=bind,source=/var/www/acme/live,target=/live,readonly',
            '--mount', 'type=bind,source=/var/www/acme/.copy/abc/new,target=/stage',
            '--entrypoint', 'cp', IMAGE, '-a', '/live/storage', '/stage/storage',
        ])
    })

    it('refuses a path that --mount would read as more than one field', () => {
        assert.throws(() => helperArgv(IMAGE, 'n', [{ source: '/var/www/a,readonly=false', target: '/x' }], ['true']), /cannot be mounted/)
        assert.throws(() => helperArgv(IMAGE, 'n', [{ source: '/var/www/a', target: '/x"y' }], ['true']), /cannot be mounted/)
    })
})

describe('hostPathOf', () => {
    it('translates through the deepest bind mount that holds the path', () => {
        assert.equal(hostPathOf('/backups/.staging/acme/run1/db', MOUNTS), '/srv/backups/hostd/.staging/acme/run1/db')
        assert.equal(hostPathOf('/var/www/acme/live', MOUNTS), '/var/www/acme/live')
        assert.equal(hostPathOf('/backups', MOUNTS), '/srv/backups/hostd')
    })

    it('answers null for a path under no bind mount, or only under a volume', () => {
        assert.equal(hostPathOf('/etc/passwd', MOUNTS), null)
        assert.equal(hostPathOf('/var/lib/hostd/backups.json', MOUNTS), null)
        assert.equal(hostPathOf('/var/wwwx/a', MOUNTS), null)
    })
})

describe('createIoHelper', () => {
    it('reads its own image and mounts once, then runs each command with host paths', async () => {
        const { runner, calls } = recorder([{ stdout: INSPECT }, { stdout: 'one' }, { stdout: 'two' }])
        let n = 0
        const helper = createIoHelper({ runner, container: 'hostd-agent', newName: () => `io-${++n}` })
        const first = await helper([{ source: '/backups/.staging/acme/run1', target: '/stage' }], ['true'], 5000)
        const second = await helper([{ source: '/var/www/acme/live', target: '/live', readOnly: true }], ['true'], 6000)
        assert.equal(first.stdout, 'one')
        assert.equal(second.stdout, 'two')
        assert.equal(calls.length, 3)
        assert.deepEqual(calls[0]!.args, ['inspect', '--format', '{"image":{{json .Image}},"mounts":{{json .Mounts}}}', 'hostd-agent'])
        assert.ok(calls[1]!.args.includes('type=bind,source=/srv/backups/hostd/.staging/acme/run1,target=/stage'))
        assert.equal(calls[1]!.timeoutMs, 5000)
        assert.ok(calls[2]!.args.includes('io-2'))
    })

    it('passes a path it is told is already the host\'s through untranslated', async () => {
        const { runner, calls } = recorder([{ stdout: INSPECT }])
        const helper = createIoHelper({ runner, container: 'hostd-agent', newName: () => 'io-1' })
        await helper([{ source: '/srv/dbdata', target: '/src', readOnly: true, host: true }], ['true'], 5000)
        assert.ok(calls[1]!.args.includes('type=bind,source=/srv/dbdata,target=/src,readonly'))
    })

    it('throws, running nothing, for a path the agent does not have bind-mounted from the host', async () => {
        const { runner, calls } = recorder([{ stdout: INSPECT }])
        const helper = createIoHelper({ runner, container: 'hostd-agent', newName: () => 'io-1' })
        await assert.rejects(helper([{ source: '/tmp/x', target: '/x' }], ['true'], 5000), /\/tmp\/x is not on a folder hostd-agent has from the host/)
        assert.equal(calls.length, 1)
    })

    it('throws when its own image cannot be read, and asks again next time', async () => {
        const { runner, calls } = recorder([{ exitCode: 1, stderr: 'no such container' }, { stdout: INSPECT }])
        const helper = createIoHelper({ runner, container: 'hostd-agent', newName: () => 'io-1' })
        await assert.rejects(helper([], ['true'], 5000), /hostd-agent's image and mounts could not be read: no such container/)
        await helper([], ['true'], 5000)
        assert.equal(calls.filter(call => call.args[0] === 'inspect').length, 2)
    })

    it('removes the container by name when the command times out or docker fails, and still answers the result', async () => {
        const { runner, calls } = recorder([{ stdout: INSPECT }, { exitCode: null, timedOut: true }, {}, { exitCode: 3, stderr: 'bad' }, {}])
        const helper = createIoHelper({ runner, container: 'hostd-agent', newName: () => 'io-1' })
        const timedOut = await helper([], ['true'], 5000)
        assert.equal(timedOut.timedOut, true)
        assert.deepEqual(calls[2]!.args, ['rm', '-f', 'io-1'])
        const failed = await helper([], ['true'], 5000)
        assert.equal(failed.exitCode, 3)
        assert.deepEqual(calls[4]!.args, ['rm', '-f', 'io-1'])
    })
})
