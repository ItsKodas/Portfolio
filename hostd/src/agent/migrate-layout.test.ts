import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { executeSteps, inspectLayout, resumeSteps, windowSteps } from './migrate-layout.ts'
import { deployTrees } from './deploy-compose.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { DeployFs } from './deploy.ts'

const project = parseRegistry(`projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010 }
      test: { dir: /var/www/acme-test, port: 5011 }
`).projects.get('acme')!
const live = project.environments.get('live')!
const test = project.environments.get('test')!
const liveFrom = deployTrees('/var/www/acme')
const liveTo = deployTrees('/var/www/acme/live')
const testFrom = deployTrees('/var/www/acme-test')
const testTo = deployTrees('/var/www/acme/test')

// failOn names the moves that throw, as `<from> <to>`.
function disk(paths: string[], failOn: string[] = []) {
    const present = new Set(paths)
    const calls: string[] = []
    const fs = {
        exists: async (path: string) => present.has(path),
        mkdir: async (dir: string) => { calls.push(`mkdir ${dir}`); present.add(dir) },
        rmdir: async (dir: string) => { calls.push(`rmdir ${dir}`); present.delete(dir) },
        removeEmptyDir: async (dir: string) => {
            calls.push(`rmdir-empty ${dir}`)
            if ([...present].some(path => path.startsWith(`${dir}/`))) throw new Error('ENOTEMPTY')
            present.delete(dir)
        },
        move: async (from: string, to: string) => {
            if (failOn.includes(`${from} ${to}`)) throw new Error('EXDEV')
            calls.push(`move ${from} ${to}`); present.delete(from); present.add(to)
        },
        owner: async () => ({ uid: 1000, gid: 1000, mode: 0o775 }),
        own: async (dir: string) => { calls.push(`own ${dir}`) },
    } as unknown as DeployFs
    return { fs, calls, present, exists: fs.exists }
}

describe('inspectLayout', () => {
    it('reads a flat live', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme', '/var/www/acme/docker-compose.yml']).exists), 'flat')
    })
    it('reads a live interrupted between leaving and arriving', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme.migrating']).exists), 'interrupted')
    })
    it('reads a live that moved but was never recorded', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme', '/var/www/acme/live', '/var/www/acme/git/.git']).exists), 'moved')
    })
    it('reads a live whose undo stopped after its tree reached prev/live as interrupted', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme', '/var/www/acme/prev/live', '/var/www/acme.next']).exists), 'interrupted')
    })
    it('still reads a flat live with a prev/live folder of its own as flat', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme', '/var/www/acme/docker-compose.yml', '/var/www/acme/prev/live']).exists), 'flat')
    })
    it('refuses to guess at a folder that is neither', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme']).exists), 'unknown')
    })
    it('reads a flat and a moved test', async () => {
        assert.equal(await inspectLayout(test, testFrom, testTo, disk(['/var/www/acme-test']).exists), 'flat')
        assert.equal(await inspectLayout(test, testFrom, testTo, disk(['/var/www/acme/test']).exists), 'moved')
        assert.equal(await inspectLayout(test, testFrom, testTo, disk(['/var/www/acme-test', '/var/www/acme/test']).exists), 'unknown')
    })
})

describe('windowSteps', () => {
    it('moves a live tree under its own name, build and repository included', () => {
        assert.deepEqual(windowSteps(live, liveFrom, liveTo), [
            { kind: 'move', from: '/var/www/acme', to: '/var/www/acme.migrating' },
            { kind: 'mkdir', dir: '/var/www/acme', like: '/var/www/acme.migrating' },
            { kind: 'mkdir', dir: '/var/www/acme/prev', like: '/var/www/acme.migrating' },
            { kind: 'move', from: '/var/www/acme.migrating', to: '/var/www/acme/prev/live' },
            { kind: 'move', from: '/var/www/acme.next', to: '/var/www/acme/live' },
            { kind: 'move', from: '/var/www/acme.git', to: '/var/www/acme/git' },
        ])
    })

    it('moves a test tree beside a nested live, from a build already in next/test', () => {
        assert.deepEqual(windowSteps(test, testFrom, testTo), [
            { kind: 'mkdir', dir: '/var/www/acme/prev', like: '/var/www/acme' },
            { kind: 'move', from: '/var/www/acme-test', to: '/var/www/acme/prev/test' },
            { kind: 'move', from: '/var/www/acme/next/test', to: '/var/www/acme/test' },
        ])
    })
})

describe('executeSteps', () => {
    it('runs every step and owns each folder it makes like its pattern', async () => {
        const { fs, calls } = disk(['/var/www/acme', '/var/www/acme.next', '/var/www/acme.git'])
        assert.deepEqual(await executeSteps(windowSteps(live, liveFrom, liveTo), fs, 'window'), { ok: true })
        assert.deepEqual(calls, [
            'move /var/www/acme /var/www/acme.migrating',
            'mkdir /var/www/acme', 'own /var/www/acme',
            'mkdir /var/www/acme/prev', 'own /var/www/acme/prev',
            'move /var/www/acme.migrating /var/www/acme/prev/live',
            'move /var/www/acme.next /var/www/acme/live',
            'move /var/www/acme.git /var/www/acme/git',
        ])
    })

    it('undoes what it did, in reverse, when a step fails', async () => {
        const { fs, calls, present } = disk(['/var/www/acme', '/var/www/acme.next', '/var/www/acme.git'], ['/var/www/acme.next /var/www/acme/live'])
        const result = await executeSteps(windowSteps(live, liveFrom, liveTo), fs, 'window')
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.undone, true)
        assert.match(!result.ok ? result.step : '', /acme\.next/)
        assert.deepEqual(calls.slice(-4), [
            'move /var/www/acme/prev/live /var/www/acme.migrating',
            'rmdir-empty /var/www/acme/prev',
            'rmdir-empty /var/www/acme',
            'move /var/www/acme.migrating /var/www/acme',
        ])
        assert.deepEqual([...present].sort(), ['/var/www/acme', '/var/www/acme.git', '/var/www/acme.next'])
    })

    // On the real disk rmdir is recursive, so an undo that carried on past a move it could not reverse
    // would remove /var/www/acme/prev with the site's running tree still inside it at prev/live.
    it('stops undoing at the first step it cannot reverse, and removes nothing', async () => {
        const { fs, calls, present } = disk(['/var/www/acme', '/var/www/acme.next', '/var/www/acme.git'], [
            '/var/www/acme.next /var/www/acme/live',
            '/var/www/acme/prev/live /var/www/acme.migrating',
        ])
        const result = await executeSteps(windowSteps(live, liveFrom, liveTo), fs, 'window')
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.undone, false)
        assert.equal(calls.some(call => call.startsWith('rmdir')), false)
        assert.ok(present.has('/var/www/acme/prev/live'))
        // What is left is a state the next deploy's resume check finishes forward.
        assert.equal(await inspectLayout(live, liveFrom, liveTo, fs.exists), 'interrupted')
    })

    it('never removes a folder it made once something is inside it', async () => {
        const { fs, present } = disk(['/var/www/acme', '/var/www/acme.next', '/var/www/acme.git', '/var/www/acme/prev/stray'], [
            '/var/www/acme.next /var/www/acme/live',
        ])
        // This call makes /var/www/acme, but something else is already under it by the time it undoes.
        present.delete('/var/www/acme')
        const result = await executeSteps([
            { kind: 'mkdir', dir: '/var/www/acme', like: '/var/www/acme.git' },
            { kind: 'move', from: '/var/www/acme.next', to: '/var/www/acme/live' },
        ], fs, 'window')
        assert.equal(!result.ok && result.undone, false)
        assert.ok(present.has('/var/www/acme/prev/stray'))
    })

    it('skips a folder that is already there rather than making or owning it', async () => {
        const { fs, calls } = disk(['/var/www/acme', '/var/www/acme/prev', '/var/www/acme-test', '/var/www/acme/next/test'])
        await executeSteps(windowSteps(test, testFrom, testTo), fs, 'window')
        assert.equal(calls.includes('mkdir /var/www/acme/prev'), false)
    })

    it('finishes an interrupted live forward, skipping moves already done', async () => {
        const { fs, calls } = disk(['/var/www/acme.migrating', '/var/www/acme', '/var/www/acme/prev', '/var/www/acme/git'])
        assert.deepEqual(await executeSteps(resumeSteps(liveFrom, liveTo), fs, 'resume'), { ok: true })
        assert.deepEqual(calls, ['move /var/www/acme.migrating /var/www/acme/prev/live'])
    })
})
