import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RegistryStore, type RegistryFs } from './registry-store.ts'
import { RegistryError } from './registry.ts'

const good = 'projects:\n  site:\n    client: cl_1\n    name: Site\n    dir: /var/www/site\n    upstream: 127.0.0.1:5011\n    services: { web: { role: site } }\n'
const other = good.replace('name: Site', 'name: Renamed')

// A file whose contents, modification time and kind the test controls, counting reads.
function fakeFs(initial: { text: string, mtimeMs: number, isFile?: boolean, nlink?: number }) {
    const state = {
        ...initial, isFile: initial.isFile ?? true, nlink: initial.nlink ?? 1, missing: false, reads: 0,
        // A read failure (EACCES, most realistically) is not the same thing as a file whose content
        // fails to parse: readFile itself never returns.
        readFails: false,
    }
    const fs: RegistryFs = {
        async stat() {
            if (state.missing) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
            return { mtimeMs: state.mtimeMs, nlink: state.nlink, isFile: () => state.isFile }
        },
        async readFile() {
            state.reads++
            if (state.readFails) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
            return state.text
        },
    }
    return { fs, state }
}

describe('RegistryStore.load', () => {
    it('loads and exposes the registry', async () => {
        const { fs } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/etc/hostd/registry/projects.yaml', fs)
        await store.load()
        assert.equal(store.current().projects.get('site')?.name, 'Site')
        assert.deepEqual(store.warnings(), [])
    })

    it('names the usual first-run mistake when compose created a directory instead of the file', async () => {
        const { fs } = fakeFs({ text: '', mtimeMs: 1, isFile: false })
        const store = new RegistryStore('/etc/hostd/registry/projects.yaml', fs)
        await assert.rejects(store.load(), (error: unknown) => {
            assert.ok(error instanceof RegistryError)
            assert.match(error.failures[0] ?? '', /is not a file \(was projects\.yaml created before the first docker compose up\?\)/)
            return true
        })
    })

    // A bind-mounted file the host has since replaced by rename: the mount still resolves to the old
    // inode, so the contents are frozen and no later edit can ever be seen.
    it('refuses to start on a registry the host has already replaced', async () => {
        const { fs } = fakeFs({ text: good, mtimeMs: 1, nlink: 0 })
        const store = new RegistryStore('/etc/hostd/registry/projects.yaml', fs)
        await assert.rejects(store.load(), (error: unknown) => {
            assert.ok(error instanceof RegistryError)
            assert.match(error.failures[0] ?? '', /replaced on the host/)
            return true
        })
    })

    it('throws on a file that does not parse', async () => {
        const { fs } = fakeFs({ text: 'projects: [', mtimeMs: 1 })
        await assert.rejects(new RegistryStore('/p', fs).load(), RegistryError)
    })

    it('refuses current() before a load', () => {
        const { fs } = fakeFs({ text: good, mtimeMs: 1 })
        assert.throws(() => new RegistryStore('/p', fs).current(), /has not been loaded/)
    })
})

describe('RegistryStore.refresh', () => {
    it('does nothing, and reads nothing, while the modification time is unchanged', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        assert.equal(await store.refresh(), false)
        assert.equal(state.reads, 1)
    })

    it('takes a changed, valid file into effect', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { text: other, mtimeMs: 2 })
        assert.equal(await store.refresh(), true)
        assert.equal(store.current().projects.get('site')?.name, 'Renamed')
    })

    it('keeps the last good registry when an edit breaks the file, and says so', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { text: 'projects: [', mtimeMs: 2 })
        assert.equal(await store.refresh(), false)
        assert.equal(store.current().projects.get('site')?.name, 'Site')
        assert.match(store.warnings()[0] ?? '', /^registry reload rejected, still using the last good version: not valid YAML/)
    })

    it('does not re-parse a rejected file every poll', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { text: 'projects: [', mtimeMs: 2 })
        await store.refresh()
        await store.refresh()
        assert.equal(state.reads, 2)
    })

    it('clears the warning once the file is fixed', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { text: 'projects: [', mtimeMs: 2 })
        await store.refresh()
        Object.assign(state, { text: other, mtimeMs: 3 })
        assert.equal(await store.refresh(), true)
        assert.deepEqual(store.warnings(), [])
    })

    // What the purge of deleted environments asks before it trusts the snapshot in use
    it('answers why the file is rejected while it is, and null again once it is fixed', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        assert.equal(store.rejected(), null)
        Object.assign(state, { text: 'projects: [', mtimeMs: 2 })
        await store.refresh()
        assert.match(store.rejected() ?? '', /not valid YAML/)
        Object.assign(state, { text: other, mtimeMs: 3 })
        await store.refresh()
        assert.equal(store.rejected(), null)
    })

    // The mtime of a replaced file never moves again, so without this check the poll below would return
    // false for ever and hostd would look healthy while silently serving a stale registry.
    it('warns, loudly and every poll, once the host has replaced the file under the mount', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/etc/hostd/registry/projects.yaml', fs)
        await store.load()
        Object.assign(state, { nlink: 0 })
        assert.equal(await store.refresh(), false)
        assert.match(store.warnings()[0] ?? '', /replaced on the host/)
        assert.match(store.warnings()[0] ?? '', /--force-recreate/)
        // Still warning on the next poll, rather than falling silent after one.
        assert.equal(await store.refresh(), false)
        assert.match(store.warnings()[0] ?? '', /replaced on the host/)
        assert.equal(store.current().projects.get('site')?.name, 'Site')
    })

    it('recovers once the mount points at a live file again', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { nlink: 0 })
        await store.refresh()
        // Same mtime as the original load, so recovery must not depend on the mtime having moved.
        Object.assign(state, { nlink: 1, text: other })
        assert.equal(await store.refresh(), true)
        assert.equal(store.current().projects.get('site')?.name, 'Renamed')
        assert.deepEqual(store.warnings(), [])
    })

    it('warns while the file is missing and reloads it when it returns, even with the old mtime', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        state.missing = true
        assert.equal(await store.refresh(), false)
        assert.match(store.warnings()[0] ?? '', /ENOENT/)
        state.missing = false
        assert.equal(await store.refresh(), true)
        assert.deepEqual(store.warnings(), [])
    })

    // Bug found on the live dedi: registry-write.ts's writer left the file unreadable to api (EACCES),
    // and the mtime moved because the writer had replaced the file. The old code recorded that new mtime
    // before the read that then failed, so it never tried again until something else touched the file
    // and moved the mtime a second time: in practice, only a container restart. A read failure must
    // instead leave the store willing to retry on the very next poll, at the same mtime.
    it('retries a read failure on the next poll, even though the mtime has not moved since', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { mtimeMs: 2, readFails: true })
        assert.equal(await store.refresh(), false)
        assert.match(store.warnings()[0] ?? '', /EACCES/)
        assert.equal(store.current().projects.get('site')?.name, 'Site')

        // Still stuck at mtime 2, still failing to read: unlike a parse failure, this must try to read
        // again on every poll, not just once.
        const readsBefore = state.reads
        assert.equal(await store.refresh(), false)
        assert.ok(state.reads > readsBefore, 'expected refresh to read the file again rather than skip it')
    })

    it('takes the file into effect once reading it starts working again, at the same mtime that used to fail', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { mtimeMs: 2, readFails: true })
        await store.refresh()
        // The mtime never moves again: only the permissions were fixed, which is exactly what happened
        // on the live dedi.
        state.readFails = false
        assert.equal(await store.refresh(), true)
        assert.equal(store.current().projects.get('site')?.name, 'Site')
        assert.deepEqual(store.warnings(), [])
    })

    // The parse-failure behaviour the comment in refresh() already explains must not change: content
    // that is wrong now will still be wrong next poll unless the mtime moves again, so a parse failure
    // is still recorded against the mtime it was seen at and not retried until that changes.
    it('still parses a broken file only once, unlike a read failure', async () => {
        const { fs, state } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/p', fs)
        await store.load()
        Object.assign(state, { text: 'projects: [', mtimeMs: 2 })
        await store.refresh()
        const readsBefore = state.reads
        await store.refresh()
        assert.equal(state.reads, readsBefore, 'a parse failure at an unchanged mtime is not read again, matching the old behaviour')
    })
})
