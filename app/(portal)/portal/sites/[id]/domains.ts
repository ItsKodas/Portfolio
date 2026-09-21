// The Domains panel's own reasoning, kept out of the component so it can be tested without rendering
// anything, the same way deploys.ts is. Nothing here asks hostd anything.

import type { Domain, DomainState } from '@/server/hostd/domains'

// What an operator is told each state means. 'unmanaged' reads as a fact about how the domain got there,
// not a problem: an operator set it up by hand and hostd has not taken it over.
const WORDS: Record<DomainState, string> = {
    unmanaged: 'set up by hand',
    pending: 'waiting for DNS',
    active: 'working',
    failed: 'gave up',
    broken: 'stopped answering',
}

const TONES: Record<DomainState, 'good' | 'warn' | 'crit' | 'idle'> = {
    unmanaged: 'idle',
    pending: 'warn',
    active: 'good',
    failed: 'crit',
    broken: 'crit',
}

export function stateWord(state: DomainState): string {
    return WORDS[state]
}

export function stateTone(state: DomainState): 'good' | 'warn' | 'crit' | 'idle' {
    return TONES[state]
}

// What a client is told about their own domain. A client owns a small business and asked one question:
// does my website address work. They did not ask about Apache, so telling them about it is a small
// failure every time, and a fault they can do nothing about is not information, it is an apology.
//
// hostd's verifyHostname already writes a client-facing sentence into `error` (translateFailure, in
// hostd/src/api/verify.ts), turning a TLS failure, an NXDOMAIN and a wrong token into three different
// fixes, most of which are the client's own DNS to make. That string is used whenever it exists, because
// it says more than any sentence written here could. When it doesn't, a state gets a plain fallback.
// Either way, anything containing a `/` is stripped before it can reach the screen: a path is never
// something a client should see, and if a future route ever lets one reach `error`, this is the one
// place that keeps it off their screen.
const FALLBACKS: Record<DomainState, string> = {
    unmanaged: 'Your website address is working.',
    pending: 'Your website address is being set up.',
    active: 'Your website address is working.',
    failed: "We couldn't finish setting up your website address. We're looking into it.",
    broken: "Your website address stopped answering. We're looking into it.",
}

export function clientSentence(domain: Domain): string {
    const said = domain.error && !domain.error.includes('/') ? domain.error : FALLBACKS[domain.state]
    return said
}

// The states an operator must act on themselves. A rolled-back vhost needs the same attention no matter
// what the domain's own state reports, because the rollback already means hostd could not keep the
// operator's last change and put the previous vhost back on its own.
export function needsYou(domain: Domain): boolean {
    if (domain.state === 'failed' || domain.state === 'broken') return true
    if (domain.vhost && !domain.vhost.ok) return true
    return false
}

// Primary first, then alphabetical, so the table shows the same order on every render of the same data
// instead of reshuffling as hostd's own list order changes.
export function sortDomains(domains: Domain[]): Domain[] {
    return [...domains].sort((a, b) => {
        if (a.primary !== b.primary) return a.primary ? -1 : 1
        return a.hostname.localeCompare(b.hostname)
    })
}
