import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { interpretSpamhaus, checkSpamhaus, lastInboundConnection } from './probes.ts'

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
})
