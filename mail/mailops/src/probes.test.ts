import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import {
    interpretSpamhaus, checkSpamhaus, probeOutboundSmtp, probeServedCertificate, lastInboundConnection, interpretPortCheck, checkInboundPort,
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

// A throwaway self-signed certificate and key for mail.dev.horizons.gg, generated for these tests only, so
// the fake server below can complete a real TLS handshake. It expires 2036-10-24T11:51:24Z.
const PROBE_KEY = [
    '-----BEGIN PRIVATE KEY-----',
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfcE+4w8kJV2OD4tB',
    'DbCyJwxeipICuLKZ84NwppwzT0ChRANCAAR1/KxY9rWLGve7kDzV/eUdDeCzfx03',
    'Xo+KvRoSPIhNTs+DcphKGToD+NHIBL0rYomUUEwawdO+xFxNv2wSg+GA',
    '-----END PRIVATE KEY-----',
    '',
].join('\n')

const PROBE_CERT = [
    '-----BEGIN CERTIFICATE-----',
    'MIIBkzCCATmgAwIBAgIUR5r5j5Y8lzF4H7tkwca/m3v/gMIwCgYIKoZIzj0EAwIw',
    'HzEdMBsGA1UEAwwUbWFpbC5kZXYuaG9yaXpvbnMuZ2cwHhcNMjYxMDI3MTE1MTI0',
    'WhcNMzYxMDI0MTE1MTI0WjAfMR0wGwYDVQQDDBRtYWlsLmRldi5ob3Jpem9ucy5n',
    'ZzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABHX8rFj2tYsa97uQPNX95R0N4LN/',
    'HTdej4q9GhI8iE1Oz4NymEoZOgP40cgEvStiiZRQTBrB077EXE2/bBKD4YCjUzBR',
    'MB0GA1UdDgQWBBR0UZA02PM4hu1tu6c+5NBCDhbowTAfBgNVHSMEGDAWgBR0UZA0',
    '2PM4hu1tu6c+5NBCDhbowTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gA',
    'MEUCIFzoJeyiROIZlO5W36O+x3hNjq/+w+9jwfPtZ5FBbGzvAiEA8otTDg4vaotP',
    'mNZi+LiB6NcFL/Kqq1uUfVXEXo+E1XI=',
    '-----END CERTIFICATE-----',
    '',
].join('\n')

const PROBE_NOT_AFTER = '2036-10-24T11:51:24.000Z'

// Just enough of an SMTP server to get a client through STARTTLS: a banner, a multi-line EHLO reply, and
// then a TLS handshake on the same socket. `starttlsReply` lets a test refuse the upgrade instead.
function fakeStarttlsServer(starttlsReply = '220 2.0.0 Ready to start TLS') {
    return net.createServer(socket => {
        socket.write('220 mail.dev.horizons.gg ESMTP\r\n')
        let buffer = ''
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString('ascii')
            if (buffer.includes('EHLO') && !buffer.includes('STARTTLS')) {
                if (buffer.endsWith('\r\n')) socket.write('250-mail.dev.horizons.gg\r\n250-PIPELINING\r\n250 STARTTLS\r\n')
                return
            }
            if (buffer.includes('STARTTLS\r\n')) {
                socket.off('data', onData)
                socket.write(`${starttlsReply}\r\n`)
                if (!starttlsReply.startsWith('220')) return
                const secure = new tls.TLSSocket(socket, { isServer: true, key: PROBE_KEY, cert: PROBE_CERT })
                secure.on('error', () => {})
            }
        }
        socket.on('data', onData)
        socket.on('error', () => {})
    })
}

async function withServer(server: net.Server, run: (port: number) => Promise<void>) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
        await run((server.address() as net.AddressInfo).port)
    } finally {
        server.close()
    }
}

describe('probeServedCertificate', () => {
    it('reads the expiry of the certificate presented after STARTTLS', async () => {
        await withServer(fakeStarttlsServer(), async port => {
            const result = await probeServedCertificate('127.0.0.1', 'mail.dev.horizons.gg', port, 2000)
            assert.equal(result.error, undefined)
            assert.equal(result.notAfter?.toISOString(), PROBE_NOT_AFTER)
        })
    })

    it('reports a refused STARTTLS as an error rather than a certificate', async () => {
        await withServer(fakeStarttlsServer('454 4.7.0 TLS not available'), async port => {
            const result = await probeServedCertificate('127.0.0.1', 'mail.dev.horizons.gg', port, 2000)
            assert.equal(result.notAfter, null)
            assert.match(result.error ?? '', /454/)
        })
    })

    it('times out when the server accepts but never speaks', async () => {
        await withServer(net.createServer(() => {}), async port => {
            const result = await probeServedCertificate('127.0.0.1', 'mail.dev.horizons.gg', port, 100)
            assert.equal(result.notAfter, null)
            assert.match(result.error ?? '', /within 100ms/)
        })
    })

    it('reports a refused connection without throwing', async () => {
        const server = net.createServer()
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const port = (server.address() as net.AddressInfo).port
        await new Promise<void>(resolve => server.close(() => resolve()))
        const result = await probeServedCertificate('127.0.0.1', 'mail.dev.horizons.gg', port, 2000)
        assert.equal(result.notAfter, null)
        assert.match(result.error ?? '', /ECONNREFUSED/)
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

    // The served-certificate probe connects from mailops over the compose network every hour. Counting
    // that as inbound would keep the staleness check green with the port forward gone.
    it('ignores connections from private addresses, such as the certificate probe on the Docker network', () => {
        const log = [
            'Sep 18 09:00:01 mail postfix/smtpd[1]: connect from unknown[172.19.0.2]',
            'Sep 18 09:00:02 mail postfix/smtpd[2]: connect from host[192.168.0.8]',
            'Sep 18 09:00:03 mail postfix/smtpd[3]: connect from host[10.0.0.5]',
        ].join('\n')
        assert.equal(lastInboundConnection(log), null)
    })

    it('still counts a public address that merely starts like a private range', () => {
        const log = 'Sep 18 09:00:01 mail postfix/smtpd[1]: connect from mx.example.com[172.32.0.1]'
        assert.equal(lastInboundConnection(log)?.getHours(), 9)
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

    // docker-mailserver 15 writes mail.log with RFC3339 timestamps rather than the syslog form.
    it('reads RFC3339 timestamps, including the offset', () => {
        const log = [
            '2026-10-27T07:17:19.039460+00:00 mail postfix/smtpd[8269]: connect from host[35.195.92.148]',
            '2026-10-27T09:05:00.000001+02:00 mail postfix/smtpd[8270]: connect from mx.example.com[1.2.3.4]',
        ].join('\n')
        const found = lastInboundConnection(log)
        assert.equal(found?.toISOString(), '2026-10-27T07:17:19.039Z')
    })

    it('reads RFC3339 timestamps with a Z suffix and no fraction', () => {
        const log = '2026-10-27T07:17:19Z mail postfix/smtpd[1]: connect from mx.example.com[1.2.3.4]'
        assert.equal(lastInboundConnection(log)?.toISOString(), '2026-10-27T07:17:19.000Z')
    })

    it('applies the localhost and private exclusions to RFC3339 lines too', () => {
        const log = [
            '2026-10-27T07:00:00.000000+00:00 mail postfix/smtpd[1]: connect from localhost[127.0.0.1]',
            '2026-10-27T07:00:01.000000+00:00 mail postfix/smtpd[2]: connect from unknown[172.19.0.2]',
            '2026-10-27T07:00:02.000000+00:00 mail postfix/smtpd[3]: disconnect from mx.example.com[1.2.3.4]',
        ].join('\n')
        assert.equal(lastInboundConnection(log), null)
    })

    it('picks the latest connection across a log that mixes both formats', () => {
        const log = [
            '2026-10-27T07:17:19.039460+00:00 mail postfix/smtpd[1]: connect from host[35.195.92.148]',
            'Oct 25 23:00:00 mail postfix/smtpd[2]: connect from mx.example.com[1.2.3.4]',
        ].join('\n')
        const found = lastInboundConnection(log, new Date('2026-10-27T12:00:00Z'))
        assert.equal(found?.toISOString(), '2026-10-27T07:17:19.039Z')
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
