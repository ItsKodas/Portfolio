// Proves a hostname actually reaches this environment's vhost, and turns a failure into a sentence a
// non-technical client can act on.
//
// A GET to a per-domain well-known path, checked over https with certificate verification left on (that
// is Node's default, and nothing here turns it off), proves more than a plain reachability check: it
// proves the name resolves, that Cloudflare (or whatever sits in front) routes it, that it reaches this
// dedi's Apache, and that Apache routes it to this environment's vhost rather than another one. An http
// check would prove less, since it says nothing about which certificate answered.

import { randomBytes } from 'node:crypto'

export const VERIFY_TIMEOUT_MS = 10_000
export const TOKEN_HEADER = 'x-hostd-token'

export type VerifyOutcome = { ok: true } | { ok: false, reason: string, client: string }

// One of three sentences shown on a page a non-technical client reads. Never an address, a port, a path
// or a stack trace: those go in `reason`, for the operator and the audit log.
const NO_RECORD = 'No record exists yet. Add the CNAME and this will start working within a few minutes.'
const NOT_PROXIED = 'The CNAME is not proxied, so the request reached us directly. Turn the proxy on in Cloudflare.'
const ELSEWHERE = 'This name points somewhere else at the moment.'
const UNREACHABLE = 'We could not reach this name. We are still checking.'

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN'])

function isTlsCode(code: string): boolean {
    return code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')
        || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'CERT_HAS_EXPIRED'
}

// What the vhost will carry as its token. Must satisfy the same pattern the agent's wire grammar
// validates a token against (`DOMAIN_TOKEN` in shared/protocol.ts) before interpolating it into an
// Apache `<Location>` path and header: a drift between the two would fail every domain action at the
// wire with a confusing refusal.
export function newToken(): string {
    return randomBytes(16).toString('hex')
}

// `proxied` decides whether a TLS failure is read as "the proxy is off" or left generic. On a proxied
// domain that advice is right: the CNAME met the origin certificate directly instead of Cloudflare's.
// On an unproxied domain (the `letsencrypt` certificate mode is for exactly this) the client pointed the
// name straight at the dedi on purpose, and telling them to turn a proxy on would contradict their own
// deliberate setup.
export function translateFailure(error: unknown, proxied: boolean): { reason: string, client: string } {
    const reason = error instanceof Error ? error.message : String(error)
    const code = error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
        ? (error as { code: string }).code
        : ''

    if (DNS_CODES.has(code)) return { reason, client: NO_RECORD }
    if (isTlsCode(code) && proxied) return { reason, client: NOT_PROXIED }
    return { reason, client: UNREACHABLE }
}

export async function verifyHostname(
    fetchImpl: typeof fetch,
    hostname: string,
    token: string,
    scheme: 'http' | 'https',
    proxied: boolean,
): Promise<VerifyOutcome> {
    const url = `${scheme}://${hostname}/.well-known/hostd/${token}`

    let response: Response
    try {
        response = await fetchImpl(url, {
            redirect: 'manual', // a redirect proves nothing about this vhost
            cache: 'no-store',
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        })
    } catch (error) {
        return { ok: false, ...translateFailure(error, proxied) }
    }

    const seen = response.headers.get(TOKEN_HEADER)
    if (seen === null) return { ok: false, reason: 'no token header in response', client: UNREACHABLE }
    if (seen !== token) return { ok: false, reason: `token mismatch: expected ${token}, saw ${seen}`, client: ELSEWHERE }
    return { ok: true }
}
