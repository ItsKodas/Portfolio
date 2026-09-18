// The checks that tell us whether the environment still matches what the design assumed. Written against an
// address we do not control, so all three are expected to change answer without warning.

import net from 'node:net'
import { Resolver } from 'node:dns/promises'
import { REQUEST_TIMEOUT_MS } from './adapters.ts'

export type SmtpProbe = { ok: boolean, banner?: string, error?: string }

// Connect to a real MX and read its greeting. A blocked port 25 shows up as a connect timeout rather than a
// refusal, so the timeout is the meaningful signal here.
export function probeOutboundSmtp(host: string, port = 25, timeoutMs = 8000): Promise<SmtpProbe> {
    return new Promise(resolve => {
        const socket = net.connect({ host, port })
        const done = (result: SmtpProbe) => {
            socket.removeAllListeners()
            socket.destroy()
            resolve(result)
        }
        let buffer = Buffer.alloc(0)
        socket.setTimeout(timeoutMs)
        socket.once('timeout', () => done({ ok: false, error: `no banner from ${host}:${port} within ${timeoutMs}ms` }))
        socket.once('error', error => done({ ok: false, error: (error as Error).message }))
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk])
            const bannerText = buffer.toString('ascii')
            const lineEnd = bannerText.indexOf('\r\n')
            if (lineEnd >= 0) {
                const banner = bannerText.substring(0, lineEnd).trim()
                socket.removeAllListeners()
                socket.destroy()
                resolve({ ok: banner.startsWith('220'), banner })
            }
        })
    })
}

export type SpamhausResult = { listed: boolean, inconclusive: boolean, codes: string[], meanings: string[] }

const SPAMHAUS_CODES: Record<string, string> = {
    '127.0.0.2': 'SBL: spam source',
    '127.0.0.3': 'SBL CSS: snowshoe spam',
    '127.0.0.4': 'XBL: exploited or compromised host',
    '127.0.0.9': 'SBL DROP',
    '127.0.0.10': 'PBL: ISP-declared non-mail range',
    '127.0.0.11': 'PBL: Spamhaus-declared non-mail range',
}

// 127.255.255.254 means the query was refused because it came through a public resolver, not that the address
// is listed. Reporting that as a listing would be a false alarm every cycle on a default resolver setup.
const REFUSED = '127.255.255.254'

export function interpretSpamhaus(codes: string[]): SpamhausResult {
    if (codes.includes(REFUSED)) {
        return { listed: false, inconclusive: true, codes, meanings: ['query refused: use a non-public DNS resolver'] }
    }
    const meanings = codes.map(code => SPAMHAUS_CODES[code] ?? `unrecognised code ${code}`)
    return { listed: codes.length > 0, inconclusive: false, codes, meanings }
}

const defaultResolve = (name: string) => new Resolver().resolve4(name)

export async function checkSpamhaus(ip: string, resolve = defaultResolve): Promise<SpamhausResult> {
    const query = `${ip.split('.').reverse().join('.')}.zen.spamhaus.org`
    try {
        return interpretSpamhaus(await resolve(query))
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // NXDOMAIN is the normal "not listed" answer. Anything else means we did not get an answer at all.
        if (code === 'ENOTFOUND' || code === 'ENODATA') {
            return { listed: false, inconclusive: false, codes: [], meanings: [] }
        }
        return { listed: false, inconclusive: true, codes: [], meanings: [`lookup failed: ${code ?? 'unknown'}`] }
    }
}

const CONNECT = /^(\w{3})\s+(\d+)\s+(\d{2}):(\d{2}):(\d{2}).*postfix\/smtpd.*connect from (?!localhost)/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Evidence that inbound 25 actually reaches us. We cannot test that ourselves from inside the network, since
// NAT loopback would report success regardless, so real deliveries are the honest signal.
export function lastInboundConnection(log: string, now = new Date()): Date | null {
    let latest: Date | null = null
    const currentMonth = now.getMonth()
    const currentYear = now.getFullYear()
    for (const line of log.split('\n')) {
        const match = CONNECT.exec(line)
        if (!match) continue
        const month = MONTHS.indexOf(match[1]!)
        if (month < 0) continue
        // If the parsed month is later than the current month, attribute it to the previous year
        const year = month > currentMonth ? currentYear - 1 : currentYear
        const when = new Date(year, month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]))
        if (!latest || when > latest) latest = when
    }
    return latest
}

export type InboundResult = { reachable: boolean, inconclusive: boolean, detail: string }

type NodeAnswer = null | Array<{ time?: number, address?: string, error?: string }>

// check-host.net connects from several nodes around the world. Reachable needs only one of them to get
// through, because any single node can sit behind its own network's outbound-25 block. Unreachable needs
// every node to have answered and failed. Anything short of that, a node still pending or nothing back at
// all, is inconclusive: reporting "could not tell" as either answer is the Spamhaus false negative again.
export function interpretPortCheck(results: Record<string, NodeAnswer>): InboundResult {
    const answers = Object.values(results)
    const total = answers.length
    const connected = answers.filter(a => Array.isArray(a) && a.some(r => r.address !== undefined)).length
    if (connected > 0) {
        return { reachable: true, inconclusive: false, detail: `reachable from ${connected} of ${total} outside nodes` }
    }
    if (total === 0) return { reachable: false, inconclusive: true, detail: 'check-host returned no nodes' }
    const pending = answers.filter(a => a === null).length
    if (pending > 0) {
        return { reachable: false, inconclusive: true, detail: `${pending} of ${total} outside nodes still pending` }
    }
    const errors = [...new Set(answers.flatMap(a => (a ?? []).map(r => r.error ?? 'no answer')))]
    return { reachable: false, inconclusive: false, detail: `unreachable from all ${total} outside nodes: ${errors.join('; ')}` }
}

const CHECK_HOST = 'https://check-host.net'

export type InboundDeps = {
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    polls?: number
    pollDelayMs?: number
    maxNodes?: number
}

// The honest test of inbound 25, which cannot be run from inside the network because NAT loopback reports
// success regardless. Never throws: check-host being down, rate limiting us, or leaving nodes unsettled
// all become inconclusive, never an exception and never a confident wrong answer.
export async function checkInboundPort(ip: string, port: number, deps: InboundDeps = {}): Promise<InboundResult> {
    const fetchImpl = deps.fetchImpl ?? fetch
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const polls = deps.polls ?? 5
    const pollDelayMs = deps.pollDelayMs ?? 3_000
    const maxNodes = deps.maxNodes ?? 4

    const get = async (url: string) => {
        const response = await fetchImpl(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        return await response.json() as Record<string, unknown>
    }

    try {
        const start = await get(`${CHECK_HOST}/check-tcp?host=${ip}:${port}&max_nodes=${maxNodes}`)
        const id = start.request_id
        if (start.ok !== 1 || typeof id !== 'string') {
            return { reachable: false, inconclusive: true, detail: `check-host did not start a check: ${JSON.stringify(start)}` }
        }
        let last: InboundResult = { reachable: false, inconclusive: true, detail: 'no result yet' }
        for (let attempt = 0; attempt < polls; attempt++) {
            await sleep(pollDelayMs)
            last = interpretPortCheck(await get(`${CHECK_HOST}/check-result/${id}`) as Record<string, NodeAnswer>)
            if (!last.inconclusive) return last
        }
        return last
    } catch (error) {
        return { reachable: false, inconclusive: true, detail: `check-host unreachable: ${(error as Error).message}` }
    }
}
