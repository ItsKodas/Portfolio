import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { BackupRunner } from './backup-runner.ts'
import { BackupStore } from './backup-state.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { BackupRecord } from '../shared/backups.ts'

const YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    capabilities: [backups]
    services: { web: { role: site } }
  widget:
    client: cl_2
    name: Widget
    dir: /var/www/widget
    upstream: 127.0.0.1:5011
    capabilities: [backups]
    services: { web: { role: site } }
`

const registry = parseRegistry(YAML)
const acme = registry.projects.get('acme')!
const widget = registry.projects.get('widget')!

function setup() {
    const store = new BackupStore('/state/backups.json', {
        readFile: async () => { throw new Error('ENOENT') },
        writeFile: async () => {}, rename: async () => {}, mkdir: async () => {},
    })
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const started: string[] = []
    const backup = async (project: { id: string }): Promise<BackupRecord> => {
        started.push(project.id)
        await held
        return {
            run: 'run1', tag: 'manual', actor: 'client', startedAt: '2026-09-21T02:00:00.000Z',
            durationMs: 1, outcome: 'ok', snapshot: 'deadbeef', reason: null, disruptive: false,
        }
    }
    const deps = { store, log: () => {}, now: () => 0, deployRunning: () => false } as never
    return { runner: new BackupRunner(deps, backup as never), release, started, store }
}

describe('BackupRunner', () => {
    it('answers at once and records the outcome later', async () => {
        const { runner, release, store } = setup()
        const reply = runner.start(acme, { tag: 'manual', actor: 'client', run: 'run1', keep: null })
        assert.deepEqual(reply, { ok: true, started: { run: 'run1', tag: 'manual' } })
        release()
        await runner.settle()
        assert.equal(store.get('acme').runs[0]?.snapshot, 'deadbeef')
    })

    it('refuses a second run for the same project', async () => {
        const { runner, release } = setup()
        runner.start(acme, { tag: 'manual', actor: 'client', run: 'run1', keep: null })
        const second = runner.start(acme, { tag: 'manual', actor: 'client', run: 'run2', keep: null })
        assert.equal(second.ok, false)
        assert.equal(!second.ok && second.code, 'busy')
        release()
        await runner.settle()
    })

    it('refuses a run on another project while one is running anywhere', async () => {
        const { runner, release, started } = setup()
        runner.start(acme, { tag: 'manual', actor: 'client', run: 'run1', keep: null })
        const other = runner.start(widget, { tag: 'scheduled', actor: 'hostd', run: 'run2', keep: null })
        assert.equal(other.ok, false)
        assert.match(!other.ok ? other.message : '', /another backup is running/)
        assert.deepEqual(started, ['acme'])
        release()
        await runner.settle()
    })

    it('refuses while a deploy is in flight for that project', async () => {
        const { store } = setup()
        const runner = new BackupRunner({ store, log: () => {}, now: () => 0, deployRunning: (id: string) => id === 'acme' } as never, (async () => {
            throw new Error('the backup should never have started')
        }) as never)
        const refused = runner.start(acme, { tag: 'scheduled', actor: 'hostd', run: 'run1', keep: null })
        assert.equal(refused.ok, false)
        assert.match(!refused.ok ? refused.message : '', /deploying/)
        assert.equal(runner.start(widget, { tag: 'manual', actor: 'client', run: 'run2', keep: null }).ok, true)
        await runner.settle()
    })

    it('records a run that crashed rather than losing it', async () => {
        const { store } = setup()
        const runner = new BackupRunner({ store, log: () => {}, now: () => 0, deployRunning: () => false } as never, (async () => { throw new Error('restic is not installed') }) as never)
        runner.start(acme, { tag: 'manual', actor: 'client', run: 'run1', keep: null })
        await runner.settle()
        assert.equal(store.get('acme').runs[0]?.outcome, 'failed')
        assert.match(store.get('acme').runs[0]?.reason ?? '', /restic is not installed/)
    })
})
