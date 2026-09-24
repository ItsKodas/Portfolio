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

    it('keeps one environment events out of another', () => {
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
