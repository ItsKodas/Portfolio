import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeployStore, type DeployStateFs } from './deploy-state.ts'
import { emptyDeploys, type DeployRecord } from '../shared/deploys.ts'

const PATH = '/var/lib/hostd/deploys.json'

const record = (commit: string, outcome: DeployRecord['outcome']): DeployRecord => ({
    commit, subject: null, actor: 'hostd', trigger: 'poll',
    startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1000, outcome, reason: null, output: null,
})

function setup(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files))
    const made: string[] = []
    const fs: DeployStateFs = {
        readFile: async path => {
            const text = store.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
            return text
        },
        writeFile: async (path, text) => { store.set(path, text) },
        rename: async (from, to) => {
            store.set(to, store.get(from)!)
            store.delete(from)
        },
        mkdir: async dir => { made.push(dir) },
    }
    return { fs, files: store, made }
}

describe('DeployStore', () => {
    it('starts empty when the file does not exist yet', async () => {
        const { fs } = setup()
        const store = new DeployStore(PATH, fs)
        await store.load()
        assert.deepEqual(store.get('acme:live'), emptyDeploys())
        assert.equal(store.isPaused('acme:live'), false)
        assert.deepEqual(store.warnings(), [])
    })

    it('reads what an earlier run wrote', async () => {
        const saved = JSON.stringify({ environments: { 'acme:live': { deploys: [record('abc1234', 'ok')], consecutiveFailures: 0, paused: false } } })
        const { fs } = setup({ [PATH]: saved })
        const store = new DeployStore(PATH, fs)
        await store.load()
        assert.equal(store.get('acme:live').deploys[0]!.commit, 'abc1234')
    })

    it('starts empty, rather than throwing, when the file is unreadable', async () => {
        const { fs } = setup({ [PATH]: 'not json at all' })
        const store = new DeployStore(PATH, fs)
        await store.load()
        assert.deepEqual(store.get('acme:live'), emptyDeploys())
        assert.equal(store.warnings().length, 1)
    })

    it('writes through a temporary file and a rename, never over the file itself', async () => {
        const { fs, files } = setup()
        const store = new DeployStore(PATH, fs)
        await store.load()
        await store.record('acme:live', record('abc1234', 'ok'))
        assert.equal(store.get('acme:live').deploys.length, 1)
        assert.deepEqual([...files.keys()], [PATH])
        const written = JSON.parse(files.get(PATH)!)
        assert.equal(written.environments['acme:live'].deploys[0].commit, 'abc1234')
    })

    it('pauses after three failures and resumes when asked', async () => {
        const { fs } = setup()
        const store = new DeployStore(PATH, fs)
        await store.load()
        await store.record('acme:live', record('a', 'failed'))
        await store.record('acme:live', record('b', 'failed'))
        await store.record('acme:live', record('c', 'rolled-back'))
        assert.equal(store.isPaused('acme:live'), true)
        await store.resume('acme:live')
        assert.equal(store.isPaused('acme:live'), false)
        assert.equal(store.get('acme:live').consecutiveFailures, 0)
        // Resuming forgets the failures, not the history itself.
        assert.equal(store.get('acme:live').deploys.length, 3)
    })

    it('keeps the history in memory even when the write fails', async () => {
        const { fs } = setup()
        const store = new DeployStore(PATH, fs)
        await store.load()
        fs.writeFile = async () => { throw new Error('disk full') }
        await store.record('acme:live', record('abc1234', 'ok'))
        assert.equal(store.get('acme:live').deploys[0]!.commit, 'abc1234')
    })
})

describe('forgetting an environment', () => {
    it('drops its history, so a new environment of that name starts clean', async () => {
        const files = new Map<string, string>()
        const fs: DeployStateFs = {
            readFile: async path => files.get(path) ?? Promise.reject(new Error('missing')),
            writeFile: async (path, text) => { files.set(path, text) },
            rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from) },
            mkdir: async () => {},
        }
        const store = new DeployStore(PATH, fs)
        await store.record('acme:uat1', record('abc1234', 'failed'))
        await store.record('acme:live', record('abc1234', 'ok'))
        await store.forget('acme:uat1')
        assert.deepEqual(store.get('acme:uat1'), emptyDeploys())
        assert.equal(store.get('acme:live').deploys.length, 1)
        const reloaded = new DeployStore(PATH, fs)
        await reloaded.load()
        assert.deepEqual(reloaded.get('acme:uat1'), emptyDeploys())
    })
})
