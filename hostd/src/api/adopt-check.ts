// Did adopting this site leave it answering? Asked by requesting the hostname once before the vhost is
// replaced and once after, and comparing the two.
//
// This lives in api rather than in the agent for one reason: the agent runs network_mode: none. It has
// no network namespace to make a request from at all, which is why nothing like this was ever built and
// why deploy-health.ts settled for Docker's own view of a container instead. api is the process with a
// network, it already reaches hostnames over https to verify them (see verify.ts), and it is already the
// process that orchestrates an adoption: it previews, it decides, it calls the agent. So it takes the
// baseline before it calls, and it asks again after. The rollback itself is still the agent's, because
// only the agent can move a file on the host.
//
// What this is NOT is verify.ts. Verification proves a hostname reaches THIS environment's vhost, by
// asking for a token only that vhost serves, and no hand-written file has ever heard of that token. The
// baseline has to be taken against the operator's own configuration, before hostd has written anything,
// so the only question that can be asked of it is the visitor's question: does this address answer.

import { describeError } from '../shared/formats.ts'

export const PROBE_TIMEOUT_MS = 10_000

// Ordered worst to best, and the order is the whole comparison. The names are what an operator reads.
//
// 4xx counts as answered on purpose. A hand-written vhost that returns 401 for a basic auth realm, or
// 404 for the bare path this asks for, is answering: the question here is whether the site went dark,
// not whether it said yes. A 3xx sits below it because a redirect where there was a page is exactly the
// shape of this outage (the template's forced :80 to https redirect, bounced back by a CDN terminating
// TLS on its own, forever) and is also what a request landing on the wrong vhost looks like.
export const GRADES = ['unreachable', 'error', 'redirect', 'answered'] as const
export type Grade = typeof GRADES[number]

// `said` is for the operator and the audit log: a status, and where a redirect pointed.
export type Answer = { grade: Grade, said: string }

function rank(grade: Grade): number {
    return GRADES.indexOf(grade)
}

// https, and the bare path, because that is the visitor's own request. http would prove less: the
// template's :80 block is a redirect by design, so an http probe would grade every adopted site a
// redirect and could never tell the loop apart from the intended behaviour. On a proxied name (every
// site on this machine today) the CDN's own certificate answers, so certificate verification staying on
// costs nothing; on an unproxied one it may fail, and a failure BEFORE adoption is a baseline of
// 'unreachable', which nothing can be worse than, so such a site is never blocked by this check.
export async function probeSite(fetchImpl: typeof fetch, hostname: string): Promise<Answer> {
    let response: Response
    try {
        response = await fetchImpl(`https://${hostname}/`, {
            // The redirect itself is the evidence. Following it would turn the loop this is looking for
            // into a fetch that spins until undici gives up, and report it as an unrelated failure.
            redirect: 'manual',
            cache: 'no-store',
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
    } catch (error) {
        return { grade: 'unreachable', said: `the request did not complete: ${describeError(error)}` }
    }
    // Nothing here reads the body, and an undrained one holds the connection open until it times out.
    await response.body?.cancel().catch(() => undefined)

    const status = response.status
    if (status >= 500) return { grade: 'error', said: `answered ${status}` }
    if (status >= 300 && status < 400) {
        const location = response.headers.get('location')
        return { grade: 'redirect', said: location === null ? `answered ${status}` : `answered ${status} to ${location}` }
    }
    return { grade: 'answered', said: `answered ${status}` }
}

// Materially worse than it was, and nothing else. Equal or better passes, which is what keeps a site
// that was ALREADY failing from being locked out of the adoption meant to fix it: a baseline of
// 'unreachable' has nothing below it, so such an adoption always goes through.
//
// The deliberate blind spot: a site that redirected before and redirects after is graded the same, so a
// 301 to www that becomes a 301 loop passes. Telling those apart means deciding what a redirect MEANT,
// which is the kind of half-understanding of somebody's configuration this codebase refuses to do. What
// it catches is the case that happened and the ones next to it: a page becoming a redirect, a page
// becoming an error, anything becoming unreachable.
export function wentDark(before: Answer, after: Answer): boolean {
    return rank(after.grade) < rank(before.grade)
}

// What the operator is told instead of "adopted". It has to say what was measured, in what order, and
// what state their server is in now, because the next thing they do is go and look at it.
export function rolledBackReason(
    hostname: string, before: Answer, after: Answer, restored: string[], problem: string | null,
): string {
    const files = restored.length === 0
        ? 'There was no hand-written file to put back, so hostd only removed its own.'
        : `hostd put ${restored.join(', ')} back and removed its own vhost.`
    const undone = problem === null
        ? `${files} Apache has reloaded, so the site should be answering as it was.`
        : `${files} That did not fully work: ${problem}`
    return `Adopting ${hostname} passed Apache's configuration test and reloaded, and then the site stopped `
        + `answering as it had. Before adopting, ${hostname} ${before.said}. Afterwards it ${after.said}. `
        + `${undone} Nothing about the hostname's own records changed. Compare the two configurations in `
        + 'the preview before trying again: the generated vhost cannot carry everything a hand-written '
        + 'one can.'
}
