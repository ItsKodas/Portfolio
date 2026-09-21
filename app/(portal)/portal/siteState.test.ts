import { describe, expect, it } from 'vitest'

import type { Project, ServiceStatus } from '@/server/hostd/projects'
import { serviceDot, servicesOf, stateOf, stateOfServices, summarise } from './siteState'

const service = (state: string): ServiceStatus => ({
    service: 'pmpc-group-web',
    role: 'site',
    state,
    health: null,
    startedAt: null,
    restartCount: null,
    image: null,
})

const project = (over: Partial<Project> = {}): Project => ({ id: 'pmpc-group', name: 'PMPC Group', valid: true, ...over })

describe('what a project list says a site is doing', () => {
    it('reads the status object a list carries', () => {
        expect(stateOf(project({ status: { ok: true, services: [service('running')] } }))).toBe('up')
    })

    it('reads the bare services a single project read answers with', () => {
        expect(stateOf(project({ services: [service('running')] }))).toBe('up')
    })

    it('calls a refused status unknown, not stopped', () => {
        // The refusal arrives inside the list entry, so the other sites still draw. Reading it as an
        // empty container list is how a site hostd could not read looks exactly like a site switched off.
        const refused = project({ status: { ok: false, code: 'failed', message: 'the agent returned no status' } })
        expect(stateOf(refused)).toBe('unknown')
    })

    it('calls a missing status unknown, not stopped', () => {
        // A list fetched without status=1, or answered by an older hostd that does not know the flag, has
        // no status field at all. Nothing was said about the containers, so nothing may be said back.
        expect(stateOf(project())).toBe('unknown')
    })

    it('still calls a site with no containers stopped', () => {
        // hostd read this one and found nothing running, which is an answer rather than the absence of one
        expect(stateOf(project({ status: { ok: true, services: [] } }))).toBe('stopped')
    })

    it('lets one bad service decide the whole site', () => {
        expect(stateOfServices([service('running'), service('exited')])).toBe('down')
        expect(stateOfServices([service('running'), service('created')])).toBe('stopped')
    })

    it('hands back the services themselves, or says it was never told', () => {
        expect(servicesOf(project({ status: { ok: true, services: [] } }))).toEqual([])
        expect(servicesOf(project())).toBe('unknown')
    })
})

describe('the line over the site list', () => {
    it('says nothing is wrong only when nothing is', () => {
        expect(summarise(['up', 'up'])).toBe('Everything is up.')
    })

    it('counts what could not be read separately from what is switched off', () => {
        expect(summarise(['unknown', 'unknown', 'stopped'])).toBe('1 is stopped, 2 could not be read.')
    })

    it('leads with what is down', () => {
        expect(summarise(['down', 'stopped'])).toBe('1 site is down, 1 is stopped.')
    })

    it('has something to say about an empty list', () => {
        expect(summarise([])).toBe('No sites yet.')
    })
})

describe('one container, in Dockers own words', () => {
    it('draws the states a dot has a colour for', () => {
        expect(serviceDot('running')).toBe('up')
        expect(serviceDot('exited')).toBe('down')
        expect(serviceDot('dead')).toBe('down')
        expect(serviceDot('paused')).toBe('paused')
        expect(serviceDot('restarting')).toBe('deploying')
        expect(serviceDot('created')).toBe('stopped')
    })

    it('refuses to guess at one it has never seen', () => {
        // Docker's list is longer than the dot's and can grow. A container in a state nobody here has
        // heard of is exactly the one not to draw a confident green dot for.
        expect(serviceDot('removing')).toBe('unknown')
        expect(serviceDot('')).toBe('unknown')
    })
})
