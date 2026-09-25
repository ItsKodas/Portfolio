// The address rule for a new environment, once, on this side. A copy of hostd's own (HORIZONS_BASE in
// hostd/src/shared/registry.ts, oneLabelBelow in hostd/src/shared/hostnames.ts): exactly one DNS label
// below horizons.gg or below live's primary domain. Its own module with no server-only import, because the
// add form builds the address in the browser and the action checks it again on the server.

export const HORIZONS_BASE = 'horizons.gg'

// One DNS label, lowercase, no dot
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export const NEEDS_ADDRESS = 'An environment needs an address.'

export function isAddressLabel(value: string): boolean {
    return LABEL.test(value)
}

// The bases a new environment's address can sit under: horizons.gg always, and live's primary domain when
// live has one
export function addressBases(liveDomain: string | null): string[] {
    return liveDomain && liveDomain !== HORIZONS_BASE ? [HORIZONS_BASE, liveDomain] : [HORIZONS_BASE]
}

// What the form offers before the prefix is edited by hand. Under horizons.gg the site id keeps one site's
// uat1 apart from another's; under the site's own domain the name alone is enough.
export function prefilledPrefix(name: string, id: string, base: string): string {
    if (name === '') return ''
    return base === HORIZONS_BASE ? `${name}-${id}` : name
}

// Why a hostname cannot be a new environment's address, in a sentence, or null when it can. liveDomain is
// live's primary domain as hostd has it now, never one the browser sent.
export function addressProblem(hostname: string, liveDomain: string | null): string | null {
    if (hostname === '') return NEEDS_ADDRESS
    const bases = addressBases(liveDomain)
    const dot = hostname.indexOf('.')
    const label = dot === -1 ? '' : hostname.slice(0, dot)
    const base = dot === -1 ? '' : hostname.slice(dot + 1)
    if (!bases.includes(base)) return `${hostname} must be under ${bases.join(' or ')}.`
    if (!isAddressLabel(label)) {
        return `${label === '' ? 'The prefix' : label} is not a valid prefix. Use lowercase letters, digits and hyphens, not starting or ending with a hyphen.`
    }
    return null
}
