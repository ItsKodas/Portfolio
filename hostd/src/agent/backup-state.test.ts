import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { BackupStore, type BackupStateFs } from './backup-state.ts'
import { emptyBackups, type BackupRecord } from '../shared/backups.ts'

const PATH = '/var/lib/hostd/backups.json'

const record = (over: Partial<BackupRecord> = {}): BackupRecord => ({
    run: 'a1b2c3d4', tag: 'scheduled', actor: 'hostd', startedAt: '2026-09-21T02:00:00.000Z',
    durationMs: 1000, outcome: 'ok', snapshot: 'deadbeef', reason: null, disruptive: false, ...over,
})

function setup(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files))
    const fs: BackupStateFs = {
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
        mkdir: async () => {},
    }
    return { fs, files: store }
}

describe('BackupStore', () => {
    it('starts empty when the file does not exist yet', async () => {
        const store = new BackupStore(PATH, setup().fs)
        await store.load()
        assert.deepEqual(store.get('acme'), emptyBackups())
        assert.equal(store.lastRunAt('acme'), null)
        assert.deepEqual(store.warnings(), [])
    })

    it('writes a record and reads it back through a second store', async () => {
        const { fs, files } = setup()
        const store = new BackupStore(PATH, fs)
        await store.load()
        await store.record('acme', record())
        const second = new BackupStore(PATH, fs)
        await second.load()
        assert.equal(second.get('acme').runs.length, 1)
        assert.equal(second.lastRunAt('acme'), Date.parse('2026-09-21T02:00:00.000Z'))
        assert.equal([...files.keys()].length, 1, 'the temporary file is renamed away, not left behind')
    })

    it('warns rather than throwing when the file is unreadable', async () => {
        const store = new BackupStore(PATH, setup({ [PATH]: 'not json' }).fs)
        await store.load()
        assert.deepEqual(store.get('acme'), emptyBackups())
        assert.equal(store.warnings().length, 1)
    })

    it('reports projects whose newest scheduled run failed', async () => {
        const store = new BackupStore(PATH, setup().fs)
        await store.load()
        await store.record('acme', record({ outcome: 'failed', snapshot: null, reason: 'the dump failed' }))
        await store.record('widget', record())
        assert.deepEqual(store.failures(), ['acme: the newest scheduled backup failed: the dump failed'])
    })

    it('keeps the record in memory even when the write fails', async () => {
        const { fs } = setup()
        const warnings: string[] = []
        const store = new BackupStore(PATH, fs, message => warnings.push(message))
        await store.load()
        fs.writeFile = async () => { throw new Error('ENOSPC: no space left on device') }
        await store.record('acme', record())
        assert.equal(store.get('acme').runs.length, 1)
        assert.equal(warnings.length, 1)
        assert.match(warnings[0] ?? '', /could not be written/)
    })
})
