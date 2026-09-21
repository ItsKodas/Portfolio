import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ScheduleStore, type ScheduleFs } from './schedule.ts'
import { defaultSchedule } from '../shared/backups.ts'
import { parseRegistry } from '../shared/registry.ts'

const PATH = '/state/schedules.json'
const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    capabilities: [backups]
    services: { web: { role: site } }
  nobackups:
    client: cl_1
    name: Plain
    dir: /var/www/plain
    upstream: 127.0.0.1:5011
    capabilities: [lifecycle]
    services: { web: { role: site } }
`)

function setup(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files))
    const fs: ScheduleFs = {
        readFile: async path => {
            const text = store.get(path)
            if (text === undefined) throw new Error('ENOENT')
            return text
        },
        writeFile: async (path, text) => { store.set(path, text) },
        rename: async (from, to) => { store.set(to, store.get(from)!); store.delete(from) },
        mkdir: async () => {},
    }
    return { fs, files: store }
}

describe('ScheduleStore', () => {
    it('gives a project with no schedule the off default', async () => {
        const store = new ScheduleStore(PATH, setup().fs)
        await store.load()
        assert.deepEqual(store.get('acme'), defaultSchedule())
    })

    it('persists a schedule and reads it back', async () => {
        const { fs } = setup()
        const store = new ScheduleStore(PATH, fs)
        await store.load()
        await store.set('acme', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        const second = new ScheduleStore(PATH, fs)
        await second.load()
        assert.equal(second.get('acme').mode, 'daily')
    })

    it('names only projects that are due, and never one without the capability', async () => {
        const { fs } = setup()
        const store = new ScheduleStore(PATH, fs)
        await store.load()
        await store.set('acme', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        await store.set('nobackups', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        const due = store.due(registry, () => null, Date.parse('2026-09-21T16:31:00Z'))
        assert.deepEqual(due.map(entry => entry.id), ['acme'])
        assert.deepEqual(due[0]?.schedule.keep, { daily: 7, weekly: 4, monthly: 3 })
    })

    it('does not name a project that already ran for this slot', async () => {
        const { fs } = setup()
        const store = new ScheduleStore(PATH, fs)
        await store.load()
        await store.set('acme', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        const due = store.due(registry, () => Date.parse('2026-09-21T16:31:00Z'), Date.parse('2026-09-21T17:00:00Z'))
        assert.deepEqual(due, [])
    })

    it('warns rather than throwing when the file is unreadable', async () => {
        const store = new ScheduleStore(PATH, setup({ [PATH]: 'not json' }).fs)
        await store.load()
        assert.deepEqual(store.get('acme'), defaultSchedule())
        assert.equal(store.warnings().length, 1)
    })

    it('keeps the schedule in memory even when the write fails', async () => {
        const { fs } = setup()
        const warnings: string[] = []
        const store = new ScheduleStore(PATH, fs, message => warnings.push(message))
        await store.load()
        fs.writeFile = async () => { throw new Error('ENOSPC: no space left on device') }
        await store.set('acme', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        assert.equal(store.get('acme').mode, 'daily')
        assert.equal(warnings.length, 1)
        assert.match(warnings[0] ?? '', /could not be written/)
    })

    it('does not name a project absent from the registry', async () => {
        const { fs } = setup()
        const store = new ScheduleStore(PATH, fs)
        await store.load()
        await store.set('removed', { mode: 'daily', hour: 2, minute: 30, weekday: 0, keep: { daily: 7, weekly: 4, monthly: 3 } })
        const due = store.due(registry, () => null, Date.parse('2026-09-21T16:31:00Z'))
        assert.deepEqual(due, [])
    })
})
