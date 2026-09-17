// The checks that tell us whether the environment still matches what the design assumed. Written against an
// address we do not control, so all three are expected to change answer without warning.

import net from 'node:net'
import { Resolver } from 'node:dns/promises'

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
