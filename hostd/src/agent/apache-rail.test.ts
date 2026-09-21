import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ApacheRail, RAIL_TIMEOUT_MS, type RailFs } from './apache-rail.ts'

// A fake host unit: it sees the request land and answers it, the way the systemd unit does. reply
// decides what it writes, so a test can make the configtest fail or make it answer the wrong request.
function setup(reply: (request: { seq: number }) => { seq: number, ok: boolean, output: string } | null = r => ({ seq: r.seq, ok: true, output: 'Syntax OK' })) {
    const files = new Map<string, string>()
    const writes: string[] = []
    let clock = 0
    const fs: RailFs = {
        async writeFile(path, text) { files.set(path, text) },
        async rename(from, to) {
            const text = files.get(from)!
            files.delete(from)
            files.set(to, text)
            writes.push(to)
            if (to.endsWith('request.json')) {
                const answer = reply(JSON.parse(text))
                if (answer) {
                    files.set('/rail/result.json', JSON.stringify(answer))
                    files.delete(to)
                }
            }
        },
        async readFile(path) {
            const text = files.get(path)
            if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            return text
        },
        async unlink(path) { files.delete(path) },
    }
    const rail = new ApacheRail('/rail', fs, {
        now: () => clock,
        sleep: async ms => { clock += ms },
    })
    return { rail, files, writes }
}

describe('ApacheRail', () => {
    it('writes the request by rename, never in place', async () => {
        const { rail, writes } = setup()
        await rail.send('reload', { write: { path: '/etc/apache2/hostd/a-live.conf', text: 'x' }, remove: [], disable: [] })
        assert.ok(writes.includes('/rail/request.json'))
    })

    it('returns the host unit\'s result', async () => {
        const { rail } = setup()
        const result = await rail.send('reload', { write: null, remove: [], disable: [] })
        assert.equal(result.ok, true)
        assert.equal(result.output, 'Syntax OK')
    })

    it('carries a failed configtest back with Apache\'s own output', async () => {
        const { rail } = setup(r => ({ seq: r.seq, ok: false, output: 'AH00526: Syntax error' }))
        const result = await rail.send('reload', { write: null, remove: [], disable: [] })
        assert.equal(result.ok, false)
        assert.match(result.output, /AH00526/)
    })

    it('increments the sequence, so two requests are never confused', async () => {
        const seen: number[] = []
        const { rail } = setup(r => { seen.push(r.seq); return { seq: r.seq, ok: true, output: '' } })
        await rail.send('reload', { write: null, remove: [], disable: [] })
        await rail.send('reload', { write: null, remove: [], disable: [] })
        assert.equal(seen[1], seen[0]! + 1)
    })

    it('ignores a result left over from an earlier request and keeps waiting', async () => {
        // The host unit answers the previous sequence, which is exactly what a stale result looks like.
        const { rail } = setup(r => ({ seq: r.seq - 1, ok: true, output: 'stale' }))
        await assert.rejects(
            rail.send('reload', { write: null, remove: [], disable: [] }),
            /did not answer/,
        )
    })

    it('gives up after the timeout, so a dead host unit fails rather than hangs', async () => {
        const { rail } = setup(() => null)
        await assert.rejects(rail.send('reload', { write: null, remove: [], disable: [] }), /did not answer/)
    })

    // An age, never a timestamp: /health compares this against a ten minute threshold, and a timestamp
    // is larger than any threshold, so the alarm would be permanently on and therefore say nothing.
    it('reports how long ago it last got an answer, not when', async () => {
        const { rail } = setup()
        assert.equal(rail.ageOfLastSuccess(), null)
        await rail.send('reload', { write: null, remove: [], disable: [] })
        assert.equal(rail.ageOfLastSuccess(), 0)
    })

    it('numbers its first request above anything a previous process left on disk', async () => {
        const { rail, files } = setup(() => null)
        // A request that timed out before a restart, and the answer the host unit left after it. A
        // counter that began again at 0 would read that answer, to a question this process never asked,
        // as its own.
        files.set('/rail/request.json', JSON.stringify({ seq: 0, action: 'reload', write: null, remove: [], disable: [] }))
        files.set('/rail/result.json', JSON.stringify({ seq: 0, ok: true, output: 'the previous operation' }))
        await assert.rejects(rail.send('reload', { write: null, remove: [], disable: [] }), /did not answer/)
        assert.equal(JSON.parse(files.get('/rail/request.json')!).seq, 1)
    })

    it('runs one request at a time, so two callers cannot interleave their sequences', async () => {
        const order: string[] = []
        const { rail } = setup(r => { order.push(`answer${r.seq}`); return { seq: r.seq, ok: true, output: '' } })
        await Promise.all([
            rail.send('reload', { write: null, remove: [], disable: [] }).then(() => order.push('done-a')),
            rail.send('reload', { write: null, remove: [], disable: [] }).then(() => order.push('done-b')),
        ])
        // The second request is not written until the first has been answered.
        assert.deepEqual(order.slice(0, 2), ['answer0', 'done-a'])
    })
})
