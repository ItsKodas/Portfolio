// The address rule for a new environment, once, on this side. A copy of hostd's own (HORIZONS_BASE in
// hostd/src/shared/registry.ts, oneLabelBelow and siteBase in hostd/src/shared/hostnames.ts): exactly one
// DNS label below horizons.gg or below the site's own domain, which is live's primary without a leading
// www. Its own module with no server-only import, because the
// add form builds the address in the browser and the action checks it again on the server.

export const HORIZONS_BASE = 'horizons.gg'

// One DNS label, lowercase, no dot
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export const NEEDS_ADDRESS = 'An environment needs an address.'

export function isAddressLabel(value: string): boolean {
    return LABEL.test(value)
}

// The site's own domain from live's primary: www.example.com means the site is example.com, so its
// environments go under example.com rather than under www.
export function siteBase(domain: string): string {
    const rest = domain.startsWith('www.') ? domain.slice(4) : null
    return rest !== null && rest.includes('.') ? rest : domain
}

// The bases a new environment's address can sit under: horizons.gg always, and the site's own domain: the
// root domain the site names, or failing that live's primary without a leading www.
export function addressBases(liveDomain: string | null, rootDomain: string | null = null): string[] {
    const base = rootDomain ?? (liveDomain ? siteBase(liveDomain) : null)
    return base && base !== HORIZONS_BASE ? [HORIZONS_BASE, base] : [HORIZONS_BASE]
}

// What the form offers before the prefix is edited by hand. Under horizons.gg the site id keeps one site's
// uat1 apart from another's; under the site's own domain the name alone is enough.
export function prefilledPrefix(name: string, id: string, base: string): string {
    if (name === '') return ''
    return base === HORIZONS_BASE ? `${name}-${id}` : name
}

// Why a hostname cannot be a new environment's address, in a sentence, or null when it can. liveDomain and
// rootDomain are as hostd has them now, never ones the browser sent.
export function addressProblem(hostname: string, liveDomain: string | null, rootDomain: string | null = null): string | null {
    if (hostname === '') return NEEDS_ADDRESS
    const bases = addressBases(liveDomain, rootDomain)
    const dot = hostname.indexOf('.')
    const label = dot === -1 ? '' : hostname.slice(0, dot)
    const base = dot === -1 ? '' : hostname.slice(dot + 1)
    if (!bases.includes(base)) return `${hostname} must be under ${bases.join(' or ')}.`
    if (!isAddressLabel(label)) {
        return `${label === '' ? 'The prefix' : label} is not a valid prefix. Use lowercase letters, digits and hyphens, not starting or ending with a hyphen.`
    }
    return null
}
