import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './config.ts'
import {
    needsRenewal, backoffMs, legoArgs,
    readCertState, writeCertState, certificateStatus, acknowledgeCurrentCertificate,
} from './certs.ts'

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

describe('backoffMs', () => {
    it('returns zero for zero failures', () => {
        assert.equal(backoffMs(0), 0)
    })

    it('returns 1 minute for the first failure', () => {
        assert.equal(backoffMs(1), 60_000)
    })

    it('doubles with each failure', () => {
        assert.equal(backoffMs(2), 120_000)
        assert.equal(backoffMs(3), 240_000)
        assert.equal(backoffMs(4), 480_000)
    })

    it('saturates at the cap rather than growing without bound', () => {
        // Cap is 1 hour (3_600_000 ms)
        assert.equal(backoffMs(7), 3_600_000)
        assert.equal(backoffMs(10), 3_600_000)
    })
})

// A self-signed certificate for mail.dev.horizons.gg, public half only, used purely so X509Certificate
// has something real to parse. It expires 2036-09-14T22:59:41Z.
const FIXTURE_CERT = [
    '-----BEGIN CERTIFICATE-----',
    'MIIDHzCCAgegAwIBAgIUds9GhZAItguiAXh35p0kZLJr1hgwDQYJKoZIhvcNAQEL',
    'BQAwHzEdMBsGA1UEAwwUbWFpbC5kZXYuaG9yaXpvbnMuZ2cwHhcNMjYwOTE3MjI1',
    'OTQxWhcNMzYwOTE0MjI1OTQxWjAfMR0wGwYDVQQDDBRtYWlsLmRldi5ob3Jpem9u',
    'cy5nZzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJo/QNiHoLkQ5ic9',
    '32Lf1/inK4CQ2viFa9X8PJz43DjtupPEZzPSc+wtu5HCHT5ALw9piNzEqU7aAJdD',
    'wt8J2pT3ppJtA2OvSp/DWo0tfnrU22TJ+usIXW/NJ6gCkwUnqWaLpo2fpo09w0oO',
    'NLAuh+f5YsgQmMd+ECK4JtjknRBxFV/B55ydWj0kq+cIGi1mMthN0wsRymiZeQc5',
    'mFDwJ5t3Guz+ooyOVlI+eT4oyzRSMvLuV94dr4KvbHz4d4UJIbmYw/8ahMumsw3N',
    'RCkF/As06Q88MzuRdJEMWf0vsB8b9tkTaPoJgZsRyXZbM8y+DI/ZomE0zjwX1xgL',
    'kAKj0BcCAwEAAaNTMFEwHQYDVR0OBBYEFAcfJQfRHsv/dnlY3RLnDPqM8OyyMB8G',
    'A1UdIwQYMBaAFAcfJQfRHsv/dnlY3RLnDPqM8OyyMA8GA1UdEwEB/wQFMAMBAf8w',
    'DQYJKoZIhvcNAQELBQADggEBAHixofW9V/e0dMEzcpoROM5cEaddGIt8mjtjmffN',
    'NEcDw7kH51FvWwS0NVrsCwN5dBXerviJw5NoKP3m0i7S15OEAXlZCf1o5EtLQN43',
    'XKNhVLv8AHWZtn8PF/L4UwxB4dZ3BSKJyIm22XJwo8bqNOr+lHPYpSGfmwpnIie9',
    'BRiVS/qOmPKVGZPEEKV5m4b/uwuDj3wxGog4UjBjaDLaz7/4j32may6DUI9gyW+n',
    'kWrB0trQQSXQ1T3oek7/0Z2X7ZY+j79i33682XXcSVaJZIaivtvBHvpqzoSymYle',
    'TqA8F7WgR8J3d4pdVg1yo+WkwYzcVJ79CNUH0YYYmoPLUoI=',
    '-----END CERTIFICATE-----',
    '',
].join('\n')

const FIXTURE_NOT_AFTER = '2036-09-14T22:59:41.000Z'

async function withCertDir(run: (certDir: string) => Promise<void>, withCert = true) {
    const certDir = join(tmpdir(), 'certs-' + Math.random().toString(36).slice(2))
    try {
        await mkdir(join(certDir, 'certificates'), { recursive: true })
        if (withCert) {
            await writeFile(join(certDir, 'certificates', `${config.mailHostname}.crt`), FIXTURE_CERT, 'utf8')
        }
        await run(certDir)
    } finally {
        await rm(certDir, { recursive: true, force: true })
    }
}

describe('cert state', () => {
    it('reads as nothing acknowledged when the marker file does not exist', async () => {
        await withCertDir(async certDir => {
            assert.deepEqual(await readCertState(certDir), { issuedNotAfter: null, acknowledgedNotAfter: null })
        })
    })

    it('reads as nothing acknowledged when the marker file is corrupt, which is the safe answer', async () => {
        await withCertDir(async certDir => {
            await writeFile(join(certDir, 'mailops-cert-state.json'), 'not json at all', 'utf8')
            assert.deepEqual(await readCertState(certDir), { issuedNotAfter: null, acknowledgedNotAfter: null })
        })
    })

    it('ignores non-string values rather than trusting them', async () => {
        await withCertDir(async certDir => {
            await writeFile(join(certDir, 'mailops-cert-state.json'), JSON.stringify({ acknowledgedNotAfter: 12345 }), 'utf8')
            assert.equal((await readCertState(certDir)).acknowledgedNotAfter, null)
        })
    })

    it('round-trips what it wrote', async () => {
        await withCertDir(async certDir => {
            const state = { issuedNotAfter: FIXTURE_NOT_AFTER, acknowledgedNotAfter: null }
            await writeCertState(certDir, state)
            assert.deepEqual(await readCertState(certDir), state)
        })
    })
})

describe('certificateStatus', () => {
    it('reports the on-disk expiry and that nothing has been acknowledged yet', async () => {
        await withCertDir(async certDir => {
            const status = await certificateStatus(config, certDir)
            assert.equal(status.onDiskNotAfter?.toISOString(), FIXTURE_NOT_AFTER)
            assert.equal(status.acknowledgedNotAfter, null)
        })
    })

    it('reports nothing on disk before the first issuance, without throwing', async () => {
        await withCertDir(async certDir => {
            assert.deepEqual(await certificateStatus(config, certDir), { onDiskNotAfter: null, acknowledgedNotAfter: null })
        }, false)
    })

    it('reports an acknowledgement once one has been recorded', async () => {
        await withCertDir(async certDir => {
            await acknowledgeCurrentCertificate(config, certDir)
            const status = await certificateStatus(config, certDir)
            assert.equal(status.acknowledgedNotAfter?.toISOString(), FIXTURE_NOT_AFTER)
            assert.equal(status.onDiskNotAfter?.getTime(), status.acknowledgedNotAfter?.getTime())
        })
    })
})

describe('acknowledgeCurrentCertificate', () => {
    it('records the certificate now on disk and returns its expiry', async () => {
        await withCertDir(async certDir => {
            const notAfter = await acknowledgeCurrentCertificate(config, certDir)
            assert.equal(notAfter?.toISOString(), FIXTURE_NOT_AFTER)
            assert.equal((await readCertState(certDir)).acknowledgedNotAfter, FIXTURE_NOT_AFTER)
        })
    })

    it('preserves what was issued rather than clobbering it', async () => {
        await withCertDir(async certDir => {
            await writeCertState(certDir, { issuedNotAfter: FIXTURE_NOT_AFTER, acknowledgedNotAfter: null })
            await acknowledgeCurrentCertificate(config, certDir)
            assert.deepEqual(await readCertState(certDir), {
                issuedNotAfter: FIXTURE_NOT_AFTER, acknowledgedNotAfter: FIXTURE_NOT_AFTER,
            })
        })
    })

    it('acknowledges nothing when there is no certificate on disk', async () => {
        await withCertDir(async certDir => {
            assert.equal(await acknowledgeCurrentCertificate(config, certDir), null)
            assert.equal((await readCertState(certDir)).acknowledgedNotAfter, null)
        }, false)
    })
})

describe('legoArgs', () => {
    it('requests the mail hostname through the Cloudflare DNS challenge', () => {
        const args = legoArgs(config, '/mail-certs', 'run')
        assert.ok(args.includes('--dns'))
        assert.ok(args.includes('cloudflare'))
        assert.ok(args.includes('--domains'))
        assert.ok(args.includes('mail.dev.horizons.gg'))
    })

    it('uses the DMARC reporting address as the ACME account contact', () => {
        assert.ok(legoArgs(config, '/mail-certs', 'run').includes('me@example.com'))
    })

    it('writes into the certificate directory', () => {
        assert.ok(legoArgs(config, '/mail-certs', 'run').includes('/mail-certs'))
    })

    it('produces the run verb for initial issuance', () => {
        const args = legoArgs(config, '/mail-certs', 'run')
        assert.ok(args.includes('run'))
        assert.ok(!args.includes('renew'))
    })

    it('produces the renew verb for renewal', () => {
        const args = legoArgs(config, '/mail-certs', 'renew')
        assert.ok(args.includes('renew'))
        assert.ok(!args.includes('run'))
    })
})
