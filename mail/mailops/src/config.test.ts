import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from './config.ts'

const base = {
    MAIL_DOMAIN: 'dev.horizons.gg',
    FORWARD_TO: 'me@example.com',
    CF_API_TOKEN: 'token',
    CF_ZONE_ID: 'zone',
    DMARC_RUA: 'me@example.com',
}

// node:assert's throws() returns undefined, so the error has to be caught by hand to inspect it.
function failuresOf(env: Record<string, string | undefined>): string[] {
    try {
        loadConfig(env)
    } catch (error) {
        assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`)
        return error.failures
    }
    assert.fail('expected loadConfig to throw ConfigError')
}

describe('loadConfig', () => {
    it('derives the mail hostname from the domain', () => {
        assert.equal(loadConfig(base).mailHostname, 'mail.dev.horizons.gg')
    })

    it('defaults the delivery targets to forward', () => {
        assert.deepEqual(loadConfig(base).deliveryTargets, ['forward'])
    })

    it('defaults the DKIM selector to mail', () => {
        assert.equal(loadConfig(base).dkimSelector, 'mail')
    })

    it('reports a missing MAIL_DOMAIN by name', () => {
        assert.deepEqual(failuresOf({ ...base, MAIL_DOMAIN: undefined }), ['MAIL_DOMAIN is required'])
    })

    it('rejects a malformed domain', () => {
        assert.deepEqual(failuresOf({ ...base, MAIL_DOMAIN: 'not a domain' }), ['MAIL_DOMAIN is not a valid domain name'])
    })

    it('collects every failure rather than stopping at the first', () => {
        assert.equal(failuresOf({}).length, 5)
    })

    it('leaves relay null when RELAY_HOST is empty', () => {
        assert.equal(loadConfig({ ...base, RELAY_HOST: '' }).relay, null)
    })

    it('populates relay when RELAY_HOST is set', () => {
        const config = loadConfig({
            ...base,
            RELAY_HOST: 'smtp.relay.test',
            RELAY_PORT: '587',
            RELAY_USER: 'user',
            RELAY_PASSWORD: 'pass',
            RELAY_SPF_INCLUDE: '_spf.relay.test',
        })
        assert.deepEqual(config.relay, {
            host: 'smtp.relay.test',
            port: 587,
            user: 'user',
            password: 'pass',
            spfInclude: '_spf.relay.test',
        })
    })

    it('rejects a relay without an SPF include, because SPF would silently break', () => {
        const failures = failuresOf({
            ...base,
            RELAY_HOST: 'smtp.relay.test',
            RELAY_USER: 'user',
            RELAY_PASSWORD: 'pass',
        })
        assert.ok(failures.includes('RELAY_SPF_INCLUDE is required when RELAY_HOST is set'))
    })
})
