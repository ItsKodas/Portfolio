import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.ts'
import { needsRenewal, legoArgs } from './certs.ts'

const config = loadConfig({
    MAIL_DOMAIN: 'dev.horizons.gg',
    FORWARD_TO: 'me@example.com',
    CF_API_TOKEN: 'token',
    CF_ZONE_ID: 'zone',
    DMARC_RUA: 'me@example.com',
})

const now = new Date('2026-09-18T00:00:00Z')

describe('needsRenewal', () => {
    it('renews when there is no certificate at all', () => {
        assert.equal(needsRenewal(null, now), true)
    })

    it('renews inside the window', () => {
        assert.equal(needsRenewal(new Date('2026-10-10T00:00:00Z'), now), true)
    })

    it('leaves a certificate alone outside the window', () => {
        assert.equal(needsRenewal(new Date('2026-12-01T00:00:00Z'), now), false)
    })

    it('renews an already expired certificate', () => {
        assert.equal(needsRenewal(new Date('2026-08-01T00:00:00Z'), now), true)
    })
})

describe('legoArgs', () => {
    it('requests the mail hostname through the Cloudflare DNS challenge', () => {
        const args = legoArgs(config, '/mail-certs')
        assert.ok(args.includes('--dns'))
        assert.ok(args.includes('cloudflare'))
        assert.ok(args.includes('--domains'))
        assert.ok(args.includes('mail.dev.horizons.gg'))
    })

    it('uses the DMARC reporting address as the ACME account contact', () => {
        assert.ok(legoArgs(config, '/mail-certs').includes('me@example.com'))
    })

    it('writes into the certificate directory', () => {
        assert.ok(legoArgs(config, '/mail-certs').includes('/mail-certs'))
    })
})
