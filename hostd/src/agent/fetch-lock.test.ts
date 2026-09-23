import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { serialisePerRepo } from './fetch-lock.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

function gated() {
    const order: string[] = []
    const releases: Array<() => void> = []
    const client = {
        call: (request: FetchRequest) => new Promise<FetchReply>(resolve => {
            const dir = 'dir' in request ? request.dir : '-'
            order.push(`start ${request.verb} ${dir}`)
            releases.push(() => { order.push(`end ${request.verb} ${dir}`); resolve({ ok: true }) })
        }),
    }
    return { client, order, releases }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('serialisePerRepo', () => {
    it('runs one call at a time against one repository', async () => {
        const { client, order, releases } = gated()
        const locked = serialisePerRepo(client)
        const first = locked.call({ verb: 'fetch', dir: '/var/www/a/git', branch: 'main', credential: null })
        const second = locked.call({ verb: 'tip', dir: '/var/www/a/git', branch: 'dev' })
        await tick()
        assert.deepEqual(order, ['start fetch /var/www/a/git'])
        releases[0]!()
        await first
        await tick()
        assert.deepEqual(order, ['start fetch /var/www/a/git', 'end fetch /var/www/a/git', 'start tip /var/www/a/git'])
        releases[1]!()
        await second
    })

    it('lets two repositories run at once', async () => {
        const { client, order, releases } = gated()
        const locked = serialisePerRepo(client)
        const a = locked.call({ verb: 'fetch', dir: '/var/www/a/git', branch: 'main', credential: null })
        const b = locked.call({ verb: 'fetch', dir: '/var/www/b/git', branch: 'main', credential: null })
        await tick()
        assert.equal(order.length, 2)
        releases.forEach(release => release())
        await Promise.all([a, b])
    })

    it('does not let a failed call hold the lock', async () => {
        const client = { call: async (): Promise<FetchReply> => { throw new Error('socket closed') } }
        const locked = serialisePerRepo(client)
        await assert.rejects(locked.call({ verb: 'tip', dir: '/var/www/a/git', branch: 'main' }))
        await assert.rejects(locked.call({ verb: 'tip', dir: '/var/www/a/git', branch: 'main' }))
    })
})
