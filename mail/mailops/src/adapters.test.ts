import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './config.ts'
import { parseTrace, parseDkimRecord, aliasMap, readDkimKey } from './adapters.ts'

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

describe('readDkimKey', () => {
    it('returns null when the key file does not exist', async () => {
        // Use a non-existent path under tmpdir to avoid actual file operations
        const nonExistent = join(tmpdir(), 'nonexistent-' + Math.random().toString(36))
        const result = await readDkimKey(nonExistent, config)
        assert.equal(result, null)
    })

    it('reads and parses a valid BIND formatted key file', async () => {
        const baseDir = join(tmpdir(), 'dkim-test-' + Math.random().toString(36))
        const keyDir = join(baseDir, 'opendkim', 'keys', config.mailDomain)
        const keyPath = join(keyDir, `${config.dkimSelector}.txt`)

        try {
            await mkdir(keyDir, { recursive: true })
            const bindContent = [
                'mail._domainkey IN TXT ( "v=DKIM1; h=sha256; k=rsa; "',
                '   "p=MIIBIjANBgkq" )  ; ----- DKIM key mail for dev.horizons.gg',
            ].join('\n')
            await writeFile(keyPath, bindContent, 'utf8')

            const result = await readDkimKey(baseDir, config)
            assert.equal(result, 'v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkq')
        } finally {
            // Clean up test directory
            try {
                await rmdir(join(baseDir, 'opendkim', 'keys', config.mailDomain))
                await rmdir(join(baseDir, 'opendkim', 'keys'))
                await rmdir(join(baseDir, 'opendkim'))
                await rmdir(baseDir)
            } catch {
                // Ignore cleanup errors
            }
        }
    })

    it('returns null when the key path is a directory instead of a file', async () => {
        const baseDir = join(tmpdir(), 'dkim-dir-test-' + Math.random().toString(36))
        const keyDir = join(baseDir, 'opendkim', 'keys', config.mailDomain)

        try {
            // Create a directory where the key file should be
            await mkdir(keyDir, { recursive: true })
            const keyAsDir = join(keyDir, `${config.dkimSelector}.txt`)
            await mkdir(keyAsDir)

            const result = await readDkimKey(baseDir, config)
            assert.equal(result, null)
        } finally {
            // Clean up test directory
            try {
                await rmdir(join(baseDir, 'opendkim', 'keys', config.mailDomain, `${config.dkimSelector}.txt`))
                await rmdir(join(baseDir, 'opendkim', 'keys', config.mailDomain))
                await rmdir(join(baseDir, 'opendkim', 'keys'))
                await rmdir(join(baseDir, 'opendkim'))
                await rmdir(baseDir)
            } catch {
                // Ignore cleanup errors
            }
        }
    })
})
