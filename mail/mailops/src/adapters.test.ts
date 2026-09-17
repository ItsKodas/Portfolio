import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.ts'
import { parseTrace, parseDkimRecord, aliasMap } from './adapters.ts'

const config = loadConfig({
    MAIL_DOMAIN: 'dev.horizons.gg',
    FORWARD_TO: 'me@example.com',
    CF_API_TOKEN: 'token',
    CF_ZONE_ID: 'zone',
    DMARC_RUA: 'me@example.com',
})

describe('parseTrace', () => {
    it('pulls the address out of a Cloudflare trace body', () => {
        assert.equal(parseTrace('fl=1f2\nh=cloudflare.com\nip=124.177.8.46\nts=1\n'), '124.177.8.46')
    })

    it('throws when no address is present', () => {
        assert.throws(() => parseTrace('h=cloudflare.com\n'), /could not determine public IP/i)
    })
})

describe('parseDkimRecord', () => {
    it('joins the quoted chunks of a BIND formatted key', () => {
        const bind = [
            'mail._domainkey IN TXT ( "v=DKIM1; h=sha256; k=rsa; "',
            '   "p=MIIBIjANBgkq" )  ; ----- DKIM key mail for dev.horizons.gg',
        ].join('\n')
        assert.equal(parseDkimRecord(bind), 'v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkq')
    })

    it('returns null for an empty file, which is how a key not yet generated looks', () => {
        assert.equal(parseDkimRecord(''), null)
    })

    it('returns null when the file has no quoted content', () => {
        assert.equal(parseDkimRecord('; a comment only'), null)
    })
})

describe('aliasMap', () => {
    it('maps the contact address to the forwarding target', () => {
        assert.ok(aliasMap(config).startsWith('contact@dev.horizons.gg me@example.com\n'))
    })

    it('adds a catch-all so nothing addressed to the domain is refused', () => {
        assert.equal(aliasMap(config), 'contact@dev.horizons.gg me@example.com\n@dev.horizons.gg me@example.com\n')
    })

    it('produces nothing for a target that is not implemented yet', () => {
        assert.equal(aliasMap({ ...config, deliveryTargets: ['ingest'] }), '')
    })
})
