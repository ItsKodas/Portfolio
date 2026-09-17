// DNS-01 rather than HTTP-01, deliberately: no inbound HTTP to expose, and renewal does not break when the
// public IP rotates. The challenge dance itself is lego's job. Delegating it keeps custom code off the path
// where custom code is least welcome.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import type { Config } from './config.ts'

const run = promisify(execFile)
const RENEWAL_WINDOW_DAYS = 30
const STATE_FILE = 'mailops-cert-state.json'
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

async function currentNotAfter(config: Config, certDir: string): Promise<Date | null> {
    const path = join(certDir, 'certificates', `${config.mailHostname}.crt`)
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

// mailserver runs SSL_TYPE=manual and does not reliably notice a manually supplied certificate changing
// on disk. mailops renews into the shared volume around day 60, and without a restart Postfix carries on
// serving the old certificate until it expires around day 90, while the on-disk file that mailops checks
// looks perfectly healthy. Restarting mailserver from here would mean handing this container the Docker
// socket, which is a far worse trade than a documented manual step. So: record what was issued, record
// what the operator confirmed mailserver picked up, and refuse to report ok until the two agree.
export type CertState = {
    issuedNotAfter: string | null
    acknowledgedNotAfter: string | null
}

export type CertStatus = {
    onDiskNotAfter: Date | null
    acknowledgedNotAfter: Date | null
}

const statePath = (certDir: string) => join(certDir, STATE_FILE)

export async function readCertState(certDir: string): Promise<CertState> {
    try {
        const parsed = JSON.parse(await readFile(statePath(certDir), 'utf8')) as Partial<CertState>
        return {
            issuedNotAfter: typeof parsed.issuedNotAfter === 'string' ? parsed.issuedNotAfter : null,
            acknowledgedNotAfter: typeof parsed.acknowledgedNotAfter === 'string' ? parsed.acknowledgedNotAfter : null,
        }
    } catch {
        // Missing or corrupt reads as "nothing acknowledged", which is the safe answer: it warns.
        return { issuedNotAfter: null, acknowledgedNotAfter: null }
    }
}

export async function writeCertState(certDir: string, state: CertState): Promise<void> {
    await mkdir(certDir, { recursive: true })
    await writeFile(statePath(certDir), JSON.stringify(state, null, 2), 'utf8')
}

// Never throws. The reload check must still be answerable on a cycle where lego failed.
export async function certificateStatus(config: Config, certDir: string): Promise<CertStatus> {
    const onDiskNotAfter = await currentNotAfter(config, certDir)
    const { acknowledgedNotAfter } = await readCertState(certDir)
    return {
        onDiskNotAfter,
        acknowledgedNotAfter: acknowledgedNotAfter ? new Date(acknowledgedNotAfter) : null,
    }
}

// What `npm run ack-cert` calls, after the operator has restarted mailserver. Records the certificate
// now on disk as the one being served, which clears the cert-reload-needed warning until the next
// issuance moves the two apart again.
export async function acknowledgeCurrentCertificate(config: Config, certDir: string): Promise<Date | null> {
    const notAfter = await currentNotAfter(config, certDir)
    if (!notAfter) return null
    const state = await readCertState(certDir)
    await writeCertState(certDir, { ...state, acknowledgedNotAfter: notAfter.toISOString() })
    return notAfter
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

        // Record what we just caused to be issued. This is the moment mailserver starts serving a
        // certificate that is about to become the wrong one, and the marker is what makes that visible.
        const issued = await currentNotAfter(config, certDir)
        if (issued) {
            const state = await readCertState(certDir)
            await writeCertState(certDir, { ...state, issuedNotAfter: issued.toISOString() })
        }
    } catch (error) {
        // Failure: increment counter and record the time so backoff applies to the next attempt.
        backoffState.consecutiveFailures += 1
        backoffState.lastFailureTime = now.getTime()
        // Re-throw so the caller logs the error via their own error handler.
        throw error
    }
}
