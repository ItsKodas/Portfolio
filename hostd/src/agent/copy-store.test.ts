import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { CopyStore, COPY_KEEP, INTERRUPTED_REASON, type CopyStoreFs } from './copy-store.ts'
import type { CopyRecord } from '../shared/protocol.ts'

const PATH = '/var/lib/hostd/copies.json'

const record = (run: string, overrides: Partial<CopyRecord> = {}): CopyRecord => ({
    project: 'acme', environment: 'uat1', run, actor: 'koda',
    startedAt: '2026-09-25T10:00:00.000Z', durationMs: 0, outcome: 'running', step: null, reason: null,
    services: ['db'], storage: ['uploads'],
    ...overrides,
})

function setup(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files))
    const writes: Array<{ path: string, flag: string | undefined }> = []
    const renames: Array<[string, string]> = []
    let failWrite = false
    const fs: CopyStoreFs = {
        readFile: async path => {
            const text = store.get(path)
            if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' })
            return text
        },
        writeFile: async (path, text, options) => {
            if (failWrite) throw new Error('ENOSPC: no space left on device')
            writes.push({ path, flag: options?.flag })
            store.set(path, text)
        },
        rename: async (from, to) => {
            renames.push([from, to])
            store.set(to, store.get(from)!)
            store.delete(from)
        },
        mkdir: async () => {},
    }
    return { fs, files: store, writes, renames, failWrites: () => { failWrite = true } }
}

describe('CopyStore', () => {
    it('keeps the last 20 runs per environment', () => {
        assert.equal(COPY_KEEP, 20)
    })

    it('starts empty when the file does not exist yet', async () => {
        const { fs } = setup()
        const store = new CopyStore(PATH, fs)
        await store.load()
        assert.deepEqual(store.list('acme', 'uat1'), [])
        assert.equal(store.get('acme', 'uat1', 'aaaaaaaa'), null)
        assert.deepEqual(store.warnings(), [])
    })

    it('writes through a temporary file in the same folder and a rename', async () => {
        const { fs, files, writes, renames } = setup()
        const store = new CopyStore(PATH, fs)
        await store.load()
        await store.start(record('aaaaaaaa'))
        assert.equal(writes.length, 1)
        assert.match(writes[0]!.path, /^\/var\/lib\/hostd\/\.copies\.json\.[0-9a-f]{12}\.tmp$/)
        assert.equal(writes[0]!.flag, 'wx')
        assert.deepEqual(renames, [[writes[0]!.path, PATH]])
        assert.deepEqual(JSON.parse(files.get(PATH)!).runs, [record('aaaaaaaa')])
    })

    it('shows a started run at once, before its write has finished', () => {
        const { fs } = setup()
        const store = new CopyStore(PATH, fs)
        void store.start(record('aaaaaaaa'))
        assert.equal(store.get('acme', 'uat1', 'aaaaaaaa')?.outcome, 'running')
    })

    it('lists one environment newest first and finds a run by id', async () => {
        const { fs } = setup()
        const store = new CopyStore(PATH, fs)
        await store.start(record('aaaaaaaa'))
        await store.start(record('bbbbbbbb'))
        await store.start(record('cccccccc', { environment: 'staging' }))
        await store.start(record('dddddddd', { project: 'other' }))
        assert.deepEqual(store.list('acme', 'uat1').map(entry => entry.run), ['bbbbbbbb', 'aaaaaaaa'])
        assert.equal(store.get('acme', 'staging', 'cccccccc')?.environment, 'staging')
        // A run of another environment is not found under this one
        assert.equal(store.get('acme', 'uat1', 'cccccccc'), null)
    })

    it('replaces a run with its finished record', async () => {
        const { fs, files } = setup()
        const store = new CopyStore(PATH, fs)
        await store.start(record('aaaaaaaa'))
        await store.finish(record('aaaaaaaa', { outcome: 'ok', durationMs: 5000 }))
        assert.deepEqual(store.list('acme', 'uat1'), [record('aaaaaaaa', { outcome: 'ok', durationMs: 5000 })])
        assert.equal(JSON.parse(files.get(PATH)!).runs[0].outcome, 'ok')
    })

    it('keeps only the last 20 runs of each environment, and leaves the others alone', async () => {
        const { fs } = setup()
        const store = new CopyStore(PATH, fs)
        await store.start(record('eeeeeeee', { environment: 'staging' }))
        for (let at = 0; at < 25; at++) await store.start(record(`${at}`.padStart(8, '0'), { outcome: 'ok' }))
        const runs = store.list('acme', 'uat1')
        assert.equal(runs.length, 20)
        assert.equal(runs[0]!.run, '00000024')
        assert.equal(runs.at(-1)!.run, '00000005')
        assert.equal(store.list('acme', 'staging').length, 1)
    })

    it('reads back what it wrote', async () => {
        const { fs, files } = setup()
        const first = new CopyStore(PATH, fs)
        await first.start(record('aaaaaaaa', { outcome: 'ok' }))
        const second = new CopyStore(PATH, setup(Object.fromEntries(files)).fs)
        await second.load()
        assert.deepEqual(second.list('acme', 'uat1'), [record('aaaaaaaa', { outcome: 'ok' })])
    })

    it('keeps the record in memory and says so when a write fails', async () => {
        const { fs, failWrites } = setup()
        const logged: string[] = []
        const store = new CopyStore(PATH, fs, message => logged.push(message))
        failWrites()
        await store.start(record('aaaaaaaa'))
        assert.equal(store.get('acme', 'uat1', 'aaaaaaaa')?.outcome, 'running')
        assert.match(logged[0] ?? '', /could not be written/)
        assert.equal(store.warnings().length, 1)
    })

    it('warns about a file it cannot read, and drops malformed entries', async () => {
        const { fs } = setup({ [PATH]: JSON.stringify({ runs: [record('aaaaaaaa'), { run: 'x' }] }) })
        const store = new CopyStore(PATH, fs)
        await store.load()
        assert.deepEqual(store.list('acme', 'uat1').map(entry => entry.run), ['aaaaaaaa'])
        const broken = new CopyStore(PATH, setup({ [PATH]: 'not json' }).fs)
        await broken.load()
        assert.match(broken.warnings()[0] ?? '', /could not be read/)
    })

    it('marks runs still running at boot as failed and hands them back', async () => {
        const { fs, files } = setup({
            [PATH]: JSON.stringify({ runs: [record('aaaaaaaa'), record('bbbbbbbb', { outcome: 'ok' }), record('cccccccc', { environment: 'staging' })] }),
        })
        const store = new CopyStore(PATH, fs)
        await store.load()
        const interrupted = await store.markInterrupted(Date.parse('2026-09-25T10:05:00.000Z'))
        assert.deepEqual(interrupted.map(entry => entry.run), ['aaaaaaaa', 'cccccccc'])
        const marked = store.get('acme', 'uat1', 'aaaaaaaa')!
        assert.equal(marked.outcome, 'failed')
        assert.equal(marked.reason, INTERRUPTED_REASON)
        assert.equal(marked.durationMs, 300_000)
        assert.equal(INTERRUPTED_REASON, 'the agent restarted during the copy')
        assert.equal(store.get('acme', 'uat1', 'bbbbbbbb')!.outcome, 'ok')
        assert.equal(JSON.parse(files.get(PATH)!).runs.filter((entry: CopyRecord) => entry.outcome === 'running').length, 0)
    })

    it('writes nothing at boot when no run was interrupted', async () => {
        const { fs, writes } = setup({ [PATH]: JSON.stringify({ runs: [record('bbbbbbbb', { outcome: 'ok' })] }) })
        const store = new CopyStore(PATH, fs)
        await store.load()
        assert.deepEqual(await store.markInterrupted(Date.now()), [])
        assert.equal(writes.length, 0)
    })
})
