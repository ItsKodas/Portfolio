import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from '../shared/registry.ts'
import type { ContainerSummary } from './docker.ts'
import { HoldingPages, holdingStateOf, holdingPagePath } from './holding-pages.ts'

const REGISTRY = parseRegistry(`
projects:
  map-pies:
    client: cl_1
    name: Mappies
    services: { web: { role: site }, db: { role: database, engine: postgres } }
    contact: { name: Jo, email: jo@example.com }
    environments:
      live:
        dir: /var/www/map-pies
        port: 5010
        domain: mappies.com
      test:
        dir: /var/www/map-pies-test
        port: 5011
      uat:
        dir: /var/www/map-pies-uat
        port: 5012
        domain: uat.mappies.com
`)

const container = (project: string, service: string, State: string, Status = ''): ContainerSummary => ({
    Id: `${project}-${service}`, State, Status,
    Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service },
})

describe('holdingStateOf', () => {
    it('says upgrading while a deploy holds the flag, whatever the containers are doing', () => {
        assert.equal(holdingStateOf(true, container('p', 'web', 'exited', 'Exited (1) 2 seconds ago')), 'upgrading')
        assert.equal(holdingStateOf(true, undefined), 'upgrading')
    })

    it('says switched off for a container docker stop took down, however the process took the signal', () => {
        for (const code of [0, 137, 143]) {
            assert.equal(holdingStateOf(false, container('p', 'web', 'exited', `Exited (${code}) 3 minutes ago`)), 'stopped', String(code))
        }
        assert.equal(holdingStateOf(false, undefined), 'stopped')
        assert.equal(holdingStateOf(false, container('p', 'web', 'created')), 'stopped')
    })

    it('says crashed for a crash loop, or a process that died on its own and stayed down', () => {
        assert.equal(holdingStateOf(false, container('p', 'web', 'restarting', 'Restarting (1) 4 seconds ago')), 'crashed')
        assert.equal(holdingStateOf(false, container('p', 'web', 'exited', 'Exited (1) 5 minutes ago')), 'crashed')
        assert.equal(holdingStateOf(false, container('p', 'web', 'dead')), 'crashed')
    })

    it('says back shortly for a site that is running but not answering', () => {
        assert.equal(holdingStateOf(false, container('p', 'web', 'running', 'Up 2 hours')), 'unavailable')
    })
})

function setup(containers: ContainerSummary[], flags: string[] = []) {
    const files = new Map<string, string>()
    const writes: string[] = []
    let now = Date.parse('2026-10-10T03:00:00Z')
    const pages = new HoldingPages({
        registry: () => REGISTRY,
        listContainers: async () => containers,
        flagUp: async key => flags.includes(key),
        writeFile: async (path, text) => { files.set(path, text); writes.push(path) },
        pageDir: '/var/www/hostd-maintenance',
        now: () => now,
    })
    return { pages, files, writes, containers, flags, advance: (ms: number) => { now += ms } }
}

const LIVE = holdingPagePath('/var/www/hostd-maintenance', 'map-pies', 'live')
const UAT = holdingPagePath('/var/www/hostd-maintenance', 'map-pies', 'uat')

describe('HoldingPages', () => {
    it('writes a page for every environment with a domain, and the shared fallback', async () => {
        const { pages, files } = setup([])
        assert.deepEqual(await pages.sweep(), [])
        assert.deepEqual([...files.keys()].sort(), [
            '/var/www/hostd-maintenance/index.html',
            '/var/www/hostd-maintenance/sites/map-pies-live.html',
            '/var/www/hostd-maintenance/sites/map-pies-uat.html',
        ])
        assert.match(files.get(LIVE) ?? '', /<h1>Mappies<\/h1>/)
        assert.match(files.get(LIVE) ?? '', /Need to reach Jo\?/)
    })

    // The compose project name is what tells the live site's container from the uat one's
    it('reads each environment from its own site container', async () => {
        const { pages, files } = setup([
            container('map-pies', 'web', 'restarting', 'Restarting (1) 4 seconds ago'),
            container('map-pies', 'db', 'running', 'Up 2 hours'),
            container('map-pies-uat', 'web', 'running', 'Up 2 hours'),
        ])
        await pages.sweep()
        assert.match(files.get(LIVE) ?? '', /Having trouble/)
        assert.match(files.get(UAT) ?? '', /Back shortly/)
    })

    it('says upgrading for an environment whose deploy holds the flag', async () => {
        const { pages, files } = setup([container('map-pies', 'web', 'running', 'Up 2 hours')], ['map-pies-live'])
        await pages.sweep()
        assert.match(files.get(LIVE) ?? '', /A new version of Mappies is being put in place/)
    })

    it('does not rewrite a page that has not changed, and keeps since from when the state began', async () => {
        const setupState = setup([container('map-pies', 'web', 'exited', 'Exited (0) 1 minute ago')])
        const { pages, files, writes } = setupState
        await pages.sweep()
        const first = files.get(LIVE)
        assert.match(first ?? '', /datetime="2026-10-10T03:00:00.000Z"/)
        const count = writes.length
        setupState.advance(60_000)
        await pages.sweep()
        assert.equal(writes.length, count)
        assert.equal(files.get(LIVE), first)
    })

    it('restarts since when the state changes', async () => {
        const state = setup([container('map-pies', 'web', 'exited', 'Exited (0) 1 minute ago')])
        await state.pages.sweep()
        state.advance(60_000)
        state.containers.splice(0, 1, container('map-pies', 'web', 'restarting', 'Restarting (1) 1 second ago'))
        await state.pages.sweep()
        assert.match(state.files.get(LIVE) ?? '', /datetime="2026-10-10T03:01:00.000Z"/)
    })

    // A project id may itself carry a dash, so the key has to be matched rather than split
    it('refreshes one page from the maintenance key alone, without asking Docker', async () => {
        const state = setup([])
        state.pages = new HoldingPages({
            registry: () => REGISTRY,
            listContainers: async () => { throw new Error('should not be asked') },
            flagUp: async () => false,
            writeFile: async (path, text) => { state.files.set(path, text) },
            pageDir: '/var/www/hostd-maintenance',
            now: Date.now,
        })
        await state.pages.refreshKey('map-pies-uat', 'upgrading')
        assert.deepEqual([...state.files.keys()], [UAT])
        assert.match(state.files.get(UAT) ?? '', /Upgrading/)
    })

    it('answers a problem rather than throwing when Docker cannot list its containers', async () => {
        const { files } = setup([])
        const pages = new HoldingPages({
            registry: () => REGISTRY,
            listContainers: async () => { throw new Error('connect ENOENT /var/run/docker.sock') },
            flagUp: async () => false,
            writeFile: async (path, text) => { files.set(path, text) },
            pageDir: '/var/www/hostd-maintenance',
            now: Date.now,
        })
        const problems = await pages.sweep()
        assert.equal(problems.length, 1)
        assert.match(problems[0] ?? '', /Docker did not list its containers/)
        // The fallback still went out
        assert.ok(files.has('/var/www/hostd-maintenance/index.html'))
    })
})
