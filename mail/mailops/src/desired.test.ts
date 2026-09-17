import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.ts'
import { spfContent, desiredRecords } from './desired.ts'

const base = {
    MAIL_DOMAIN: 'dev.horizons.gg',
    FORWARD_TO: 'me@example.com',
    CF_API_TOKEN: 'token',
    CF_ZONE_ID: 'zone',
    DMARC_RUA: 'me@example.com',
}

const direct = loadConfig(base)
const relayed = loadConfig({
    ...base,
    RELAY_HOST: 'smtp.relay.test',
    RELAY_USER: 'u',
    RELAY_PASSWORD: 'p',
    RELAY_SPF_INCLUDE: '_spf.relay.test',
})

const find = (records: ReturnType<typeof desiredRecords>, name: string, type: string) =>
    records.find(r => r.name === name && r.type === type)

describe('spfContent', () => {
    it('authorises only the mail host when sending direct', () => {
        assert.equal(spfContent(direct), 'v=spf1 a:mail.dev.horizons.gg ~all')
    })

    it('adds the relay include when a relay is configured', () => {
        assert.equal(spfContent(relayed), 'v=spf1 a:mail.dev.horizons.gg include:_spf.relay.test ~all')
    })

    it('ends in a soft fail while the setup is unproven', () => {
        assert.ok(spfContent(direct).endsWith('~all'))
    })
})

describe('desiredRecords', () => {
    it('points the A record at the current IP, unproxied, with a short TTL', () => {
        const a = find(desiredRecords(direct, '1.2.3.4', null), 'mail.dev.horizons.gg', 'A')
        assert.deepEqual(a, {
            type: 'A', name: 'mail.dev.horizons.gg', content: '1.2.3.4', ttl: 60, proxied: false,
        })
    })

    it('points MX at the mail host with priority 10', () => {
        const mx = find(desiredRecords(direct, '1.2.3.4', null), 'dev.horizons.gg', 'MX')
        assert.equal(mx?.content, 'mail.dev.horizons.gg')
        assert.equal(mx?.priority, 10)
    })

    it('starts DMARC at p=none with the configured reporting address', () => {
        const dmarc = find(desiredRecords(direct, '1.2.3.4', null), '_dmarc.dev.horizons.gg', 'TXT')
        assert.equal(dmarc?.content, 'v=DMARC1; p=none; rua=mailto:me@example.com')
    })

    it('omits the DKIM record until the key exists, keeping the other four', () => {
        const records = desiredRecords(direct, '1.2.3.4', null)
        assert.equal(find(records, 'mail._domainkey.dev.horizons.gg', 'TXT'), undefined)
        assert.equal(records.length, 4)
    })

    it('publishes the DKIM record once the key appears', () => {
        const key = 'v=DKIM1; h=sha256; k=rsa; p=ABC123'
        const dkim = find(desiredRecords(direct, '1.2.3.4', key), 'mail._domainkey.dev.horizons.gg', 'TXT')
        assert.equal(dkim?.content, key)
    })

    it('never marks any record proxied, because Cloudflare cannot proxy SMTP', () => {
        for (const record of desiredRecords(direct, '1.2.3.4', 'v=DKIM1; p=X')) {
            assert.notEqual(record.proxied, true)
        }
    })
})
