import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createHostPortReader, parseProcNetTcp, probeArgv } from './host-ports.ts'
import type { Runner, RunResult } from './compose.ts'

const IMAGE = `sha256:${'c'.repeat(64)}`

// Real rows, trimmed: sshd on 22 (0016), something on 5004 (138C) and 127.0.0.1:5001 (1389) listening,
// and an established connection from 5006 (138E) that is not a listener.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 00000000:138C 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1389 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3 1 0000000000000000 100 0 0 10 0
   3: 0100007F:138E 0100007F:D431 01 00000000:00000000 00:00000000 00000000     0        0 4 1 0000000000000000 20 4 30 10 -1
`
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1396 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5 1 0000000000000000 100 0 0 10 0
`

function recorder(results: Array<Partial<RunResult>>) {
    const calls: Array<{ command: string, args: string[] }> = []
    const runner: Runner = async (command, args) => {
        calls.push({ command, args })
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...(results.shift() ?? {}) }
    }
    return { runner, calls }
}

describe('parseProcNetTcp', () => {
    it('keeps only listening sockets, IPv4 and IPv6, decoding their hex ports', () => {
        assert.deepEqual([...parseProcNetTcp(TCP + TCP6)].sort((a, b) => a - b), [22, 5001, 5004, 5014])
    })

    it('answers nothing for text that is not a listing', () => {
        assert.equal(parseProcNetTcp('cat: can\'t open\n').size, 0)
    })
})

describe('probeArgv', () => {
    // Through sh rather than cat alone, so a host with IPv6 disabled (no /proc/net/tcp6) still answers
    // its IPv4 listing instead of exiting 1 and failing every probe
    it('runs cat in the host network namespace, from a local image, tolerating a missing tcp6', () => {
        assert.deepEqual(probeArgv(IMAGE, 'hostd-port-probe-1'), [
            'run', '--rm', '--name', 'hostd-port-probe-1', '--network', 'host', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--pull', 'never', '--entrypoint', 'sh', IMAGE,
            '-c', 'cat /proc/net/tcp; cat /proc/net/tcp6 2>/dev/null; true',
        ])
    })
})

describe('createHostPortReader', () => {
    const published = async () => new Set([5007])

    it('looks up its own image once, probes, and adds Docker\'s published ports', async () => {
        const { runner, calls } = recorder([{ stdout: `${IMAGE}\n` }, { stdout: TCP + TCP6 }])
        const read = createHostPortReader({ runner, container: 'hostd-agent', published, newName: () => 'probe-1' })
        const seen = await read()
        assert.equal(seen.ok, true)
        assert.deepEqual([...(seen.ok ? seen.ports : [])].sort((a, b) => a - b), [22, 5001, 5004, 5007, 5014])
        assert.deepEqual(calls[0], { command: 'docker', args: ['inspect', '--format', '{{.Image}}', 'hostd-agent'] })
        assert.deepEqual(calls[1], { command: 'docker', args: probeArgv(IMAGE, 'probe-1') })
    })

    it('answers one reading for calls close together', async () => {
        let now = 0
        const { runner, calls } = recorder([{ stdout: IMAGE }, { stdout: TCP }, { stdout: TCP }])
        const read = createHostPortReader({ runner, container: 'hostd-agent', published, now: () => now, cacheMs: 2000 })
        await read()
        await read()
        assert.equal(calls.length, 2)
        now = 5000
        await read()
        // The image is not looked up again, only the probe runs
        assert.equal(calls.length, 3)
    })

    it('fails, and removes the container, when the probe times out', async () => {
        const { runner, calls } = recorder([{ stdout: IMAGE }, { timedOut: true, exitCode: null }, {}])
        const read = createHostPortReader({ runner, container: 'hostd-agent', published, newName: () => 'probe-2' })
        const seen = await read()
        assert.deepEqual(seen, { ok: false, problem: 'could not read the host\'s ports: the probe timed out' })
        assert.deepEqual(calls[2], { command: 'docker', args: ['rm', '-f', 'probe-2'] })
    })

    it('fails when the probe exits non-zero', async () => {
        const { runner } = recorder([{ stdout: IMAGE }, { exitCode: 125, stderr: 'Unable to find image' }, {}])
        const seen = await createHostPortReader({ runner, container: 'hostd-agent', published })()
        assert.equal(seen.ok, false)
        assert.match(seen.ok ? '' : seen.problem, /could not read the host's ports: Unable to find image/)
    })

    it('reads an IPv4 listing alone, for a host with IPv6 disabled', async () => {
        const { runner } = recorder([{ stdout: IMAGE }, { stdout: TCP }])
        const seen = await createHostPortReader({ runner, container: 'hostd-agent', published })()
        assert.deepEqual([...(seen.ok ? seen.ports : [])].sort((a, b) => a - b), [22, 5001, 5004, 5007])
    })

    // A host always has something listening (sshd at least), so an empty listing is a broken probe.
    it('fails on an empty listing rather than calling every port free', async () => {
        const { runner } = recorder([{ stdout: IMAGE }, { stdout: '' }])
        const seen = await createHostPortReader({ runner, container: 'hostd-agent', published })()
        assert.deepEqual(seen, { ok: false, problem: 'could not read the host\'s ports: the listing was empty' })
    })

    it('fails when its own image cannot be read', async () => {
        const { runner } = recorder([{ exitCode: 1, stderr: 'No such object: hostd-agent' }])
        const seen = await createHostPortReader({ runner, container: 'hostd-agent', published })()
        assert.equal(seen.ok, false)
        assert.match(seen.ok ? '' : seen.problem, /hostd-agent's image could not be read/)
    })

    it('fails when Docker\'s published ports cannot be read', async () => {
        const { runner } = recorder([{ stdout: IMAGE }, { stdout: TCP }])
        const broken = async (): Promise<Set<number>> => { throw new Error('socket closed') }
        const seen = await createHostPortReader({ runner, container: 'hostd-agent', published: broken })()
        assert.deepEqual(seen, { ok: false, problem: 'could not read Docker\'s published ports: socket closed' })
    })
})
