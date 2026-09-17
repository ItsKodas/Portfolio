import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rmdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './config.ts'
import { parseTrace, parseDkimRecord, aliasMap, readDkimKey, readLogTail, fetchPublicIp, REQUEST_TIMEOUT_MS } from './adapters.ts'

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

    it('installs no catch-all by default, because only contact@ was ever authorised', () => {
        assert.equal(aliasMap(config), 'contact@dev.horizons.gg me@example.com\n')
        assert.ok(!aliasMap(config).includes('@dev.horizons.gg me@example.com\n@'))
        assert.equal(aliasMap(config).trim().split('\n').length, 1)
    })

    it('adds the catch-all only when it is explicitly opted into', () => {
        assert.equal(
            aliasMap({ ...config, acceptCatchall: true }),
            'contact@dev.horizons.gg me@example.com\n@dev.horizons.gg me@example.com\n',
        )
    })

    it('produces nothing for a target that is not implemented yet', () => {
        assert.equal(aliasMap({ ...config, deliveryTargets: ['ingest'] }), '')
    })
})

describe('fetchPublicIp', () => {
    it('carries an abort signal, so a stalled request cannot freeze the cycle', async () => {
        let seen: RequestInit | undefined
        const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
            seen = init
            return new Response('ip=124.177.8.46\n')
        }) as unknown as typeof fetch

        assert.equal(await fetchPublicIp(impl), '124.177.8.46')
        assert.ok(seen?.signal, 'no AbortSignal was passed')
        assert.equal(seen.signal.aborted, false)
        assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 30_000)
    })
})

describe('readLogTail', () => {
    async function withLogFile(contents: string, run: (path: string) => Promise<void>) {
        const dir = join(tmpdir(), 'logtail-' + Math.random().toString(36).slice(2))
        const path = join(dir, 'mail.log')
        await mkdir(dir, { recursive: true })
        try {
            await writeFile(path, contents, 'utf8')
            await run(path)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    }

    it('returns the whole file, and no error, when it is smaller than the window', async () => {
        await withLogFile('one\ntwo\nthree\n', async path => {
            assert.deepEqual(await readLogTail(path), { text: 'one\ntwo\nthree\n' })
        })
    })

    it('reads only the tail of a file larger than the window', async () => {
        // 2000 numbered lines, then a marker. Only the marker end of the file should come back.
        const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(60)}`)
        lines.push('THE LAST LINE')
        await withLogFile(lines.join('\n') + '\n', async path => {
            const tail = await readLogTail(path, 4096)
            assert.equal(tail.error, undefined)
            assert.ok(tail.text.length <= 4096)
            assert.ok(tail.text.includes('THE LAST LINE'))
            assert.ok(!tail.text.includes('line 0 '), 'the head of the file must not be read')
        })
    })

    it('discards the partial first line a positioned read lands on', async () => {
        const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${'y'.repeat(60)}`)
        await withLogFile(lines.join('\n') + '\n', async path => {
            const tail = await readLogTail(path, 1000)
            // Every line that survives must be whole, which for this fixture means starting with "line ".
            for (const line of tail.text.split('\n').filter(Boolean)) {
                assert.match(line, /^line \d+ y+$/)
            }
        })
    })

    // A freshly deployed stack genuinely has no log yet. A wrong MAIL_LOG_FILE looks identical unless
    // the two are distinguished, and it silently disables the inbound-staleness check forever.
    it('treats a missing file as empty with no error, because a new stack has no log', async () => {
        const missing = join(tmpdir(), 'no-such-log-' + Math.random().toString(36).slice(2), 'mail.log')
        assert.deepEqual(await readLogTail(missing), { text: '' })
    })

    // A directory reads as empty on some platforms and throws on others, so the type is checked rather
    // than the read being left to fail. Either way it must not be mistaken for an empty log.
    it('reports an error for a path that exists but is not a regular file', async () => {
        const dir = join(tmpdir(), 'logtail-dir-' + Math.random().toString(36).slice(2))
        await mkdir(dir, { recursive: true })
        try {
            const tail = await readLogTail(dir)
            assert.equal(tail.text, '')
            assert.ok(tail.error, 'a directory in place of the log file must be reported, not swallowed')
            assert.match(tail.error, /logtail-dir-/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('handles an empty file without reporting an error', async () => {
        await withLogFile('', async path => {
            assert.deepEqual(await readLogTail(path), { text: '' })
        })
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
