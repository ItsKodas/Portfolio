import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeletedStore, DELETED_KEEP_MS, type DeletedRecord, type DeletedStoreFs } from './deleted-store.ts'

const PATH = '/var/lib/hostd/deleted-environments.json'
const DAY = 24 * 60 * 60_000

const record = (environment: string, deletedAt: string, project = 'acme'): DeletedRecord => ({
    project, environment, deletedAt,
    trash: `/var/www/${project}/.deleted/${environment}-${Math.floor(Date.parse(deletedAt) / 1000)}`,
    composeName: `${project}-${environment}`,
    node: { dir: `/var/www/${project}/${environment}`, branch: 'develop', port: 5020, domain: `${environment}.acme.com` },
    actor: 'koda',
})

function setup(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files))
    const writes: Array<{ path: string, flag: string | undefined }> = []
    const renames: Array<[string, string]> = []
    let failWrite = false
    const fs: DeletedStoreFs = {
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

describe('DeletedStore', () => {
    it('keeps a deleted environment for 30 days', () => {
        assert.equal(DELETED_KEEP_MS, 30 * DAY)
    })

    it('starts empty when the file does not exist yet', async () => {
        const { fs } = setup()
        const store = new DeletedStore(PATH, fs)
        await store.load()
        assert.deepEqual(store.list(), [])
        assert.deepEqual(store.warnings(), [])
    })

    it('writes through a temporary file in the same folder and a rename, never over the file itself', async () => {
        const { fs, files, writes, renames } = setup()
        const store = new DeletedStore(PATH, fs)
        await store.load()
        await store.add(record('uat1', '2026-09-24T10:00:00.000Z'))

        assert.equal(writes.length, 1)
        assert.notEqual(writes[0]!.path, PATH)
        assert.ok(writes[0]!.path.startsWith('/var/lib/hostd/.deleted-environments.json.'))
        assert.equal(writes[0]!.flag, 'wx')
        assert.deepEqual(renames, [[writes[0]!.path, PATH]])
        assert.equal(files.size, 1)
    })

    it('reads back what it wrote, and removes exactly the record named', async () => {
        const { fs, files } = setup()
        const first = new DeletedStore(PATH, fs)
        await first.load()
        await first.add(record('uat1', '2026-09-01T10:00:00.000Z'))
        await first.add(record('uat1', '2026-09-20T10:00:00.000Z'))
        await first.add(record('uat2', '2026-09-20T10:00:00.000Z', 'other'))

        const second = new DeletedStore(PATH, { ...fs, readFile: async path => files.get(path)! })
        await second.load()
        assert.deepEqual(second.list(), first.list())
        assert.equal(second.list('acme').length, 2)
        assert.equal(second.list('other').length, 1)

        await second.remove('acme', 'uat1', '2026-09-01T10:00:00.000Z')
        assert.deepEqual(second.list('acme').map(entry => entry.deletedAt), ['2026-09-20T10:00:00.000Z'])
    })

    it('says whether a name is still in the trash', async () => {
        const { fs } = setup()
        const store = new DeletedStore(PATH, fs)
        await store.load()
        await store.add(record('uat1', '2026-09-20T10:00:00.000Z'))

        assert.equal(store.deletedWithin('acme', 'uat1'), true)
        assert.equal(store.deletedWithin('acme', 'uat2'), false)
        assert.equal(store.deletedWithin('other', 'uat1'), false)
    })

    // Past 30 days but not yet purged (an hour normally, for ever while a volume refuses to go), the old
    // volumes still carry the compose name a new environment of that name would run under.
    it('still blocks a name whose record is older than 30 days, until the purge drops it', async () => {
        const { fs } = setup()
        const store = new DeletedStore(PATH, fs)
        await store.load()
        await store.add(record('uat1', new Date(Date.now() - 40 * DAY).toISOString()))
        assert.equal(store.deletedWithin('acme', 'uat1'), true)
        await store.remove('acme', 'uat1', store.list()[0]!.deletedAt)
        assert.equal(store.deletedWithin('acme', 'uat1'), false)
    })

    // What a restore leaves behind when prev or next could not go back: nothing restorable, only folders
    // for the purge to remove, so the name is not blocked by it
    it('says which deleted environment holds a compose name, leaving leftovers out', async () => {
        const { fs } = setup()
        const store = new DeletedStore(PATH, fs)
        await store.load()
        await store.add({ ...record('test', '2026-09-20T10:00:00.000Z', 'other'), composeName: 'acme-uat1' })
        await store.add(record('uat2', '2026-09-20T10:00:00.000Z'))
        assert.equal(store.composeNameDeleted('acme-uat1'), 'other test')
        assert.equal(store.composeNameDeleted('acme-uat3'), null)
        await store.update({ ...record('uat2', '2026-09-20T10:00:00.000Z'), leftovers: true })
        assert.equal(store.composeNameDeleted('acme-uat2'), null)
    })

    it('replaces a record in place, and does not count leftovers as a deleted environment', async () => {
        const { fs } = setup()
        const store = new DeletedStore(PATH, fs)
        await store.load()
        const original = record('uat1', '2026-09-20T10:00:00.000Z')
        await store.add(original)
        await store.update({ ...original, leftovers: true })
        assert.deepEqual(store.list(), [{ ...original, leftovers: true }])
        assert.equal(store.deletedWithin('acme', 'uat1'), false)
    })

    // The record is what makes a trash folder restorable and purgeable: a delete that goes ahead without
    // one would leave a folder nothing knows about, so a failed write is the caller's to undo.
    it('throws on a failed write and keeps what it had', async () => {
        const { fs, failWrites } = setup()
        const store = new DeletedStore(PATH, fs)
        await store.load()
        await store.add(record('uat1', '2026-09-20T10:00:00.000Z'))
        failWrites()
        await assert.rejects(store.add(record('uat2', '2026-09-21T10:00:00.000Z')), /no space/)
        assert.deepEqual(store.list().map(entry => entry.environment), ['uat1'])
        await assert.rejects(store.remove('acme', 'uat1', '2026-09-20T10:00:00.000Z'), /no space/)
        assert.deepEqual(store.list().map(entry => entry.environment), ['uat1'])
    })

    // Starting empty over an unreadable file and then writing would forget every trash folder it named.
    it('refuses to write over a file it could not read, and warns about it', async () => {
        const { fs, files } = setup({ [PATH]: 'not json' })
        const store = new DeletedStore(PATH, fs)
        await store.load()
        assert.equal(store.warnings().length, 1)
        await assert.rejects(store.add(record('uat1', '2026-09-20T10:00:00.000Z')), /could not be read/)
        assert.equal(files.get(PATH), 'not json')
    })

    it('drops malformed entries on load rather than trusting them', async () => {
        const saved = JSON.stringify({ environments: [record('uat1', '2026-09-20T10:00:00.000Z'), { project: 'acme' }] })
        const { fs } = setup({ [PATH]: saved })
        const store = new DeletedStore(PATH, fs)
        await store.load()
        assert.deepEqual(store.list().map(entry => entry.environment), ['uat1'])
        assert.equal(store.warnings().length, 1)
    })
})
