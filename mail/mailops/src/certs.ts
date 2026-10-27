// DNS-01 rather than HTTP-01, deliberately: no inbound HTTP to expose, and renewal does not break when the
// public IP rotates. The challenge dance itself is lego's job. Delegating it keeps custom code off the path
// where custom code is least welcome.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import type { Config } from './config.ts'

const run = promisify(execFile)
const RENEWAL_WINDOW_DAYS = 30
const INITIAL_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 3_600_000

// Backoff state persists across calls within the same process, tracking consecutive lego failures.
// On success, the count resets. This prevents hammering Let's Encrypt rate limits (5 per hostname per hour)
// when transient DNS or ACME issues occur.
const backoffState: { lastFailureTime: number | null; consecutiveFailures: number } = {
    lastFailureTime: null,
    consecutiveFailures: 0,
}

export function needsRenewal(notAfter: Date | null, now: Date, windowDays = RENEWAL_WINDOW_DAYS): boolean {
    if (!notAfter) return true
    const daysLeft = (notAfter.getTime() - now.getTime()) / 86_400_000
    return daysLeft < windowDays
}

export function backoffMs(consecutiveFailures: number): number {
    if (consecutiveFailures === 0) return 0
    // Exponential: 1min, 2min, 4min, 8min, 16min, 32min, 60min (capped)
    const exponential = INITIAL_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1)
    return Math.min(exponential, MAX_BACKOFF_MS)
}

export function legoArgs(config: Config, certDir: string, mode: 'run' | 'renew'): string[] {
    return [
        '--accept-tos',
        '--email', config.dmarcRua,
        '--dns', 'cloudflare',
        '--domains', config.mailHostname,
        '--path', certDir,
        mode,
    ]
}

const certPath = (config: Config, certDir: string) => join(certDir, 'certificates', `${config.mailHostname}.crt`)

async function currentNotAfter(config: Config, certDir: string): Promise<Date | null> {
    const path = certPath(config, certDir)
    try {
        const pem = await readFile(path, 'utf8')
        return new Date(new X509Certificate(pem).validTo)
    } catch (err) {
        // ENOENT is the normal state before issuance. Log nothing for it.
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            return null
        }
        // Any other error is anomalous (permissions, corrupt cert, etc). Warn the operator.
        const errorCode = err instanceof Error && 'code' in err ? err.code : 'unknown'
        console.warn(`Warning: cannot read certificate from ${path}: ${errorCode}`)
        return null
    }
}

// How a renewal reaches Postfix: lego rewrites the files in the shared volume, and docker-mailserver's
// changedetector (which checksums SSL_CERT_PATH and SSL_KEY_PATH when SSL_TYPE=manual) copies them into
// place and reloads Postfix a few seconds later. Nothing here restarts mailserver, and nothing needs to.
// What used to be missing was any evidence that the reload happened, so health.ts now compares this
// on-disk expiry with the certificate probeServedCertificate reads off the wire.
export type CertStatus = {
    onDiskNotAfter: Date | null
    // When the certificate file last changed, so a renewal from this very cycle gets a moment for the
    // changedetector to reload Postfix before a mismatch counts against it.
    onDiskChangedAt: Date | null
    servedNotAfter?: Date | null
    servedError?: string | null
}

// Never throws. The reload and expiry checks must still be answerable on a cycle where lego failed.
export async function certificateStatus(config: Config, certDir: string): Promise<CertStatus> {
    const onDiskNotAfter = await currentNotAfter(config, certDir)
    let onDiskChangedAt: Date | null = null
    if (onDiskNotAfter) {
        try {
            onDiskChangedAt = (await stat(certPath(config, certDir))).mtime
        } catch {
            onDiskChangedAt = null
        }
    }
    return { onDiskNotAfter, onDiskChangedAt }
}

export async function ensureCertificate(config: Config, certDir: string, now: Date): Promise<void> {
    const notAfter = await currentNotAfter(config, certDir)
    if (!needsRenewal(notAfter, now)) {
        // Reset backoff on successful discovery of a valid cert. Errors only trigger backoff if they
        // occur during the lego invocation, not during cert inspection.
        backoffState.consecutiveFailures = 0
        return
    }

    // Check if we are currently in backoff from a recent failure.
    const currentBackoffMs = backoffMs(backoffState.consecutiveFailures)
    if (backoffState.lastFailureTime && now.getTime() - backoffState.lastFailureTime < currentBackoffMs) {
        const msUntilRetry = currentBackoffMs - (now.getTime() - backoffState.lastFailureTime)
        const minutesUntilRetry = Math.round(msUntilRetry / 60_000)
        console.log(`[mailops] Deferring lego attempt due to ${backoffState.consecutiveFailures} consecutive failure(s), next try in ~${minutesUntilRetry}m`)
        return
    }

    const mode = notAfter ? 'renew' : 'run'
    const args = legoArgs(config, certDir, mode)

    try {
        // lego reads the Cloudflare credential from CF_DNS_API_TOKEN, so the same scoped token serves both the
        // record reconciliation and the certificate challenge.
        await run('lego', args, { env: { ...process.env, CF_DNS_API_TOKEN: config.cfApiToken } })
        // Success: reset backoff counter.
        backoffState.consecutiveFailures = 0
        backoffState.lastFailureTime = null
    } catch (error) {
        // Failure: increment counter and record the time so backoff applies to the next attempt.
        backoffState.consecutiveFailures += 1
        backoffState.lastFailureTime = now.getTime()
        // Re-throw so the caller logs the error via their own error handler.
        throw error
    }
}
