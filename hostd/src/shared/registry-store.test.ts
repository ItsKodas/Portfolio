import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RegistryStore, type RegistryFs } from './registry-store.ts'
import { RegistryError } from './registry.ts'

const good = 'projects:\n  site:\n    client: cl_1\n    name: Site\n    dir: /var/www/site\n    upstream: 127.0.0.1:5011\n    services: { web: { role: site } }\n'
const other = good.replace('name: Site', 'name: Renamed')

// A file whose contents, modification time and kind the test controls, counting reads.
function fakeFs(initial: { text: string, mtimeMs: number, isFile?: boolean }) {
    const state = { ...initial, isFile: initial.isFile ?? true, missing: false, reads: 0 }
    const fs: RegistryFs = {
        async stat() {
            if (state.missing) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
            return { mtimeMs: state.mtimeMs, isFile: () => state.isFile }
        },
        async readFile() {
            state.reads++
            return state.text
        },
    }
    return { fs, state }
}

describe('RegistryStore.load', () => {
    it('loads and exposes the registry', async () => {
        const { fs } = fakeFs({ text: good, mtimeMs: 1 })
        const store = new RegistryStore('/etc/hostd/projects.yaml', fs)
        await store.load()
        assert.equal(store.current().projects.get('site')?.name, 'Site')
        assert.deepEqual(store.warnings(), [])
    })

    it('names the usual first-run mistake when compose created a directory instead of the file', async () => {
        const { fs } = fakeFs({ text: '', mtimeMs: 1, isFile: false })
        const store = new RegistryStore('/etc/hostd/projects.yaml', fs)
        await assert.rejects(store.load(), (error: unknown) => {
            assert.ok(error instanceof RegistryError)
            assert.match(error.failures[0] ?? '', /is not a file \(was projects\.yaml created before the first docker compose up\?\)/)
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
})
