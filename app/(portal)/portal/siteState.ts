// What a site is doing, read the same way everywhere it is shown. The dashboard and the site page both
// draw a dot per site from the same listing, and each had its own copy of this: the dashboard's learned to
// say "unknown", the site page's did not, so the same list of five sites read "could not be read" on one
// page and "stopped" on the other. One copy, one answer.
//
// Deliberately no 'server-only' import: this is plain logic over data a caller already has, and its test
// runs it directly.

import type { Project, ServiceStatus } from '@/server/hostd/projects'

export type SiteState = 'up' | 'down' | 'stopped' | 'unknown'

// What a list actually carries. hostd answers /projects?status=1 with a status object per project
// (hostd/src/api/routes.ts builds it, hostd/src/shared/protocol.ts types it) and puts its refusal inside
// that object rather than failing the whole list, so both arms have to be handled. The bare `services`
// field is what a single project read answers with, kept here as a fallback so this reads either shape.
// A refusal, an absence and a real empty list are three different answers. Collapsing the first two into
// an empty list is how a site hostd could not read looks exactly like a site that is switched off.
export function servicesOf(site: Project): ServiceStatus[] | 'unknown' {
    if (site.status) return site.status.ok ? site.status.services : 'unknown'
    return site.services ?? 'unknown'
}

// One project's worst service decides how the whole site reads: a site whose web container is down is
// down, whatever its database is doing.
export function stateOfServices(services: ServiceStatus[] | 'unknown'): SiteState {
    if (services === 'unknown') return 'unknown'
    // No containers at all is a project hostd knows about whose compose has never been up
    if (!services.length) return 'stopped'
    if (services.some(service => service.state === 'exited' || service.state === 'dead')) return 'down'
    if (services.some(service => service.state !== 'running')) return 'stopped'
    return 'up'
}

export function stateOf(site: Project): SiteState {
    return stateOfServices(servicesOf(site))
}

// What the line under the heading says. It counted only the sites that were down, so five stopped sites
// gave nought and it printed "Everything is up." over a dashboard where nothing was running.
export function summarise(states: SiteState[]): string {
    if (!states.length) return 'No sites yet.'
    const count = (want: SiteState) => states.filter(state => state === want).length
    const parts: string[] = []
    const down = count('down')
    const stopped = count('stopped')
    const unknown = count('unknown')
    if (down) parts.push(`${down} ${down === 1 ? 'site is' : 'sites are'} down`)
    if (stopped) parts.push(`${stopped} ${stopped === 1 ? 'is' : 'are'} stopped`)
    if (unknown) parts.push(`${unknown} could not be read`)
    if (!parts.length) return 'Everything is up.'
    return `${parts.join(', ')}.`
}
