import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {
    interpretSpamhaus, checkSpamhaus, probeOutboundSmtp, lastInboundConnection, interpretPortCheck, checkInboundPort,
} from './probes.ts'

describe('interpretSpamhaus', () => {
    it('reads a PBL listing as listed', () => {
        const result = interpretSpamhaus(['127.0.0.10'])
        assert.equal(result.listed, true)
        assert.equal(result.inconclusive, false)
        assert.deepEqual(result.meanings, ['PBL: ISP-declared non-mail range'])
    })

    it('reads an XBL listing, which is the one an inherited IP brings', () => {
        assert.deepEqual(interpretSpamhaus(['127.0.0.4']).meanings, ['XBL: exploited or compromised host'])
    })

    it('treats the public-resolver refusal as inconclusive, not as a listing', () => {
        const result = interpretSpamhaus(['127.255.255.254'])
        assert.equal(result.listed, false)
        assert.equal(result.inconclusive, true)
    })

    it('reports nothing listed for an empty answer', () => {
        assert.deepEqual(interpretSpamhaus([]), { listed: false, inconclusive: false, codes: [], meanings: [] })
    })
})

describe('checkSpamhaus', () => {
    it('queries the reversed address', async () => {
        const seen: string[] = []
        await checkSpamhaus('124.177.8.46', async name => { seen.push(name); return [] })
        assert.deepEqual(seen, ['46.8.177.124.zen.spamhaus.org'])
    })

    it('treats NXDOMAIN as not listed', async () => {
        const result = await checkSpamhaus('1.2.3.4', async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }) })
        assert.equal(result.listed, false)
        assert.equal(result.inconclusive, false)
    })

    it('treats any other resolver error as inconclusive', async () => {
        const result = await checkSpamhaus('1.2.3.4', async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }) })
        assert.equal(result.inconclusive, true)
    })
})

describe('probeOutboundSmtp', () => {
    it('accepts a banner delivered in a single chunk', async () => {
        const server = net.createServer(socket => {
            socket.write('220 mail.example.com ESMTP\r\n')
            socket.end()
        })
        return new Promise<void>((resolve, reject) => {
            server.listen(0, '127.0.0.1', async () => {
                try {
                    const addr = server.address() as net.AddressInfo
                    const result = await probeOutboundSmtp('127.0.0.1', addr.port, 500)
                    assert.equal(result.ok, true)
                    assert(result.banner?.includes('220'))
                    resolve()
                } catch (error) {
                    reject(error)
                } finally {
                    server.close()
                }
            })
        })
    })

    it('accepts a banner split across multiple chunks with a small delay', async () => {
        const server = net.createServer(socket => {
            socket.write('220 mail')
            setImmediate(() => {
                socket.write('.example.com ESMTP\r\n')
                socket.end()
            })
        })
        return new Promise<void>((resolve, reject) => {
            server.listen(0, '127.0.0.1', async () => {
                try {
                    const addr = server.address() as net.AddressInfo
                    const result = await probeOutboundSmtp('127.0.0.1', addr.port, 500)
                    assert.equal(result.ok, true)
                    assert(result.banner?.includes('mail.example.com'))
                    resolve()
                } catch (error) {
                    reject(error)
                } finally {
                    server.close()
                }
            })
        })
    })

    it('times out when the server accepts but never sends a banner', async () => {
        const server = net.createServer(() => {
            // Accept connection but do not send anything
        })
        return new Promise<void>((resolve, reject) => {
            server.listen(0, '127.0.0.1', async () => {
                try {
                    const addr = server.address() as net.AddressInfo
                    const result = await probeOutboundSmtp('127.0.0.1', addr.port, 100)
                    assert.equal(result.ok, false)
                    assert(result.error?.includes('no banner'))
                    resolve()
                } catch (error) {
                    reject(error)
                } finally {
                    server.close()
                }
            })
        })
    })
})

describe('lastInboundConnection', () => {
    it('finds the most recent inbound connection', () => {
        const log = [
            'Sep 18 09:00:01 mail postfix/smtpd[1]: connect from mail-sor.google.com[209.85.220.41]',
            'Sep 18 11:30:02 mail postfix/smtpd[2]: connect from mx.example.com[1.2.3.4]',
        ].join('\n')
        const found = lastInboundConnection(log)
        assert.equal(found?.getMonth(), 8)
        assert.equal(found?.getDate(), 18)
        assert.equal(found?.getHours(), 11)
    })

    it('ignores connections from localhost, which are our own health checks', () => {
        const log = 'Sep 18 09:00:01 mail postfix/smtpd[1]: connect from localhost[127.0.0.1]'
        assert.equal(lastInboundConnection(log), null)
    })

    it('returns null for a log with no connections yet', () => {
        assert.equal(lastInboundConnection('Sep 18 09:00:01 mail postfix/master[1]: daemon started'), null)
    })

    it('attributes a line from a later month to the previous year', () => {
        // Simulate being in January 2027, looking at a December 2026 log entry
        const currentDate = new Date('2027-01-02')
        const log = 'Dec 31 23:59:01 mail postfix/smtpd[1]: connect from mx.example.com[1.2.3.4]'
        const found = lastInboundConnection(log, currentDate)
        assert.equal(found?.getFullYear(), 2026)
        assert.equal(found?.getMonth(), 11) // December is month 11
        assert.equal(found?.getDate(), 31)
    })

    it('attributes a line from the current month to the current year', () => {
        // Simulate being in September 2026, looking at a September entry
        const currentDate = new Date('2026-09-18')
        const log = 'Sep 15 10:30:01 mail postfix/smtpd[1]: connect from mx.example.com[1.2.3.4]'
        const found = lastInboundConnection(log, currentDate)
        assert.equal(found?.getFullYear(), 2026)
        assert.equal(found?.getMonth(), 8) // September is month 8
    })

    it('attributes a line from an earlier month to the current year', () => {
        // Simulate being in September 2026, looking at an August entry
        const currentDate = new Date('2026-09-18')
        const log = 'Aug 20 14:22:01 mail postfix/smtpd[1]: connect from mx.example.com[1.2.3.4]'
        const found = lastInboundConnection(log, currentDate)
        assert.equal(found?.getFullYear(), 2026)
        assert.equal(found?.getMonth(), 7) // August is month 7
    })
})

describe('interpretPortCheck', () => {
    const connected = [{ time: 0.01, address: '124.177.8.46' }]
    const timedOut = [{ error: 'Connection timed out' }]
    const refused = [{ error: 'Connection refused' }]

    it('is reachable when any node connected, even if others failed', () => {
        const result = interpretPortCheck({ a: connected, b: timedOut, c: timedOut })
        assert.equal(result.reachable, true)
        assert.equal(result.inconclusive, false)
    })

    it('is unreachable only when every node failed, and says why', () => {
        const result = interpretPortCheck({ a: timedOut, b: refused })
        assert.equal(result.reachable, false)
        assert.equal(result.inconclusive, false)
        assert.match(result.detail, /Connection timed out/)
    })

    it('is inconclusive while a node is still pending, even if the rest failed', () => {
        assert.equal(interpretPortCheck({ a: timedOut, b: null }).inconclusive, true)
    })

    it('is inconclusive when no node has answered at all', () => {
        assert.equal(interpretPortCheck({ a: null, b: null }).inconclusive, true)
    })

    it('is inconclusive for an empty result rather than reading it as unreachable', () => {
        assert.equal(interpretPortCheck({}).inconclusive, true)
    })
})

function fakeCheckHost(responses: unknown[]) {
    const calls: { url: string, init?: RequestInit }[] = []
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        const next = responses.shift()
        if (next instanceof Error) throw next
        return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { impl, calls }
}

const noWait = async () => {}

describe('checkInboundPort', () => {
    it('asks check-host to connect to the address and port, then reads the result', async () => {
        const { impl, calls } = fakeCheckHost([
            { ok: 1, request_id: 'abc123' },
            { a: [{ time: 0.02, address: '124.177.8.46' }] },
        ])
        const result = await checkInboundPort('124.177.8.46', 25, { fetchImpl: impl, sleep: noWait })
        assert.equal(result.reachable, true)
        assert.match(calls[0]!.url, /check-tcp\?host=124\.177\.8\.46(:|%3A)25/)
        assert.match(calls[1]!.url, /check-result\/abc123$/)
        assert.equal((calls[0]!.init?.headers as Record<string, string>).Accept, 'application/json')
    })

    it('keeps polling while nodes are pending, then reports the settled answer', async () => {
        const { impl } = fakeCheckHost([
            { ok: 1, request_id: 'abc' },
            { a: null, b: null },
            { a: [{ error: 'Connection timed out' }], b: [{ error: 'Connection timed out' }] },
        ])
        const result = await checkInboundPort('1.2.3.4', 25, { fetchImpl: impl, sleep: noWait })
        assert.equal(result.reachable, false)
        assert.equal(result.inconclusive, false)
    })

    it('is inconclusive rather than unreachable when nodes never settle', async () => {
        const { impl } = fakeCheckHost([{ ok: 1, request_id: 'abc' }, ...Array(10).fill({ a: null })])
        const result = await checkInboundPort('1.2.3.4', 25, { fetchImpl: impl, sleep: noWait, polls: 3 })
        assert.equal(result.inconclusive, true)
    })

    it('is inconclusive when check-host refuses to start a check', async () => {
        const { impl } = fakeCheckHost([{ error: 'limit exceeded' }])
        assert.equal((await checkInboundPort('1.2.3.4', 25, { fetchImpl: impl, sleep: noWait })).inconclusive, true)
    })

    it('never throws when check-host itself is unreachable, reporting inconclusive instead', async () => {
        const { impl } = fakeCheckHost([new Error('getaddrinfo ENOTFOUND check-host.net')])
        const result = await checkInboundPort('1.2.3.4', 25, { fetchImpl: impl, sleep: noWait })
        assert.equal(result.inconclusive, true)
        assert.match(result.detail, /ENOTFOUND/)
    })

    it('bounds every request with an abort signal', async () => {
        const { impl, calls } = fakeCheckHost([
            { ok: 1, request_id: 'abc' },
            { a: [{ time: 0.02, address: '1.2.3.4' }] },
        ])
        await checkInboundPort('1.2.3.4', 25, { fetchImpl: impl, sleep: noWait })
        assert.equal(calls.length, 2)
        for (const call of calls) assert.ok(call.init?.signal instanceof AbortSignal)
    })
})
