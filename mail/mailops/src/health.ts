// Two tiers, split on one rule: never fail closed on a condition whose failure mode is lost mail. Config
// errors knowable before we accept anything stop the process. Everything environmental warns and keeps running,
// because a stack that kills itself over a closed port receives nothing while the port is closed.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SmtpProbe, SpamhausResult } from './probes.ts'
import type { ReconcileResult } from './reconcile.ts'
import type { CertStatus } from './certs.ts'

export class BootGateError extends Error {
    constructor(readonly failures: string[]) {
        super(`Refusing to start:\n  ${failures.join('\n  ')}`)
        this.name = 'BootGateError'
    }
}

export type BootChecks = {
    outbound: SmtpProbe
    publicIp: string | null
    cloudflareOk: boolean
}

export function evaluateBootGate(checks: BootChecks): string[] {
    const failures: string[] = []
    if (!checks.outbound.ok) failures.push(`outbound port 25 is unreachable: ${checks.outbound.error ?? 'no banner'}`)
    if (!checks.publicIp) failures.push('public IP could not be determined')
    if (!checks.cloudflareOk) failures.push('Cloudflare rejected CF_API_TOKEN or CF_ZONE_ID')
    return failures
}

export type Warning = { check: string, detail: string }

export type StatusInput = {
    reconcile: ReconcileResult
    spamhaus: SpamhausResult
    lastInbound: Date | null
    now: Date
    inboundStaleAfterHours?: number
    logError?: string | null
    certError?: string | null
    cert?: CertStatus | null
}

export const ACK_CERT_COMMAND = 'docker compose restart mailserver && docker compose exec mailops npm run ack-cert'

export function collectWarnings(input: StatusInput): Warning[] {
    const warnings: Warning[] = []
    const staleAfter = input.inboundStaleAfterHours ?? 48

    if (input.reconcile.conflicts.length > 0) {
        warnings.push({
            check: 'dns-conflict',
            detail: `records not maintained because something unmanaged is in the way: ${input.reconcile.conflicts.join(', ')}`,
        })
    }

    // A record we keep rewriting with unchanged desired content is never going to converge on its own.
    // The guard in reconcile has stopped writing it; this is what tells the operator that happened,
    // and it also means the record is now stale until someone looks.
    if (input.reconcile.loops.length > 0) {
        warnings.push({
            check: 'dns-write-loop',
            detail: `stopped rewriting records that never converge, so they are now stale: ${input.reconcile.loops.join(', ')}`,
        })
    }

    // Inconclusive is not a listing. Warning on it would fire every cycle behind a public resolver.
    if (input.spamhaus.listed) {
        warnings.push({ check: 'spamhaus', detail: input.spamhaus.meanings.join('; ') })
    }

    // The spec lists "certificate approaching expiry with renewal failing" as its own degrade-and-shout
    // condition. It used to be invisible here: ensureCertificate threw, the cycle aborted, and the whole
    // status file collapsed to one generic cycle-failed warning that hid the Spamhaus state, the DNS
    // conflict list and the inbound-staleness check along with it.
    if (input.certError) {
        warnings.push({ check: 'cert-renewal', detail: `certificate renewal failed: ${input.certError}` })
    }

    // mailserver runs SSL_TYPE=manual and does not reliably notice the certificate file changing, so a
    // renewal around day 60 that nobody restarts for means Postfix keeps serving the old certificate
    // until it expires on the wire around day 90, while the file mailops checks looks perfectly fine.
    // Checking the file rather than what is actually being served is precisely how that stays invisible.
    if (input.cert?.onDiskNotAfter) {
        const onDisk = input.cert.onDiskNotAfter
        const acked = input.cert.acknowledgedNotAfter
        if (!acked || acked.getTime() !== onDisk.getTime()) {
            const serving = acked
                ? `mailserver was last restarted for a certificate expiring ${acked.toISOString()}`
                : 'mailserver has never been restarted for a certificate mailops issued'
            warnings.push({
                check: 'cert-reload-needed',
                detail: `${serving}, but the certificate on disk expires ${onDisk.toISOString()}. Until they agree, assume Postfix is serving the older one. Run: ${ACK_CERT_COMMAND}`,
            })
        }
    }

    // A log we cannot read looks exactly like a log with nothing in it, which silently disables the
    // inbound-staleness check below: the only real evidence that inbound 25 still reaches us.
    if (input.logError) {
        warnings.push({ check: 'log-unreadable', detail: `${input.logError}, so inbound staleness cannot be checked` })
    }

    // Only meaningful once we have received at least once. A fresh stack has no history and is not unhealthy.
    if (input.lastInbound) {
        const hours = (input.now.getTime() - input.lastInbound.getTime()) / 3_600_000
        if (hours > staleAfter) {
            warnings.push({ check: 'inbound-stale', detail: `no inbound connection for ${Math.floor(hours)}h` })
        }
    }

    return warnings
}

export async function writeStatus(path: string, warnings: Warning[], now: Date): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ ok: warnings.length === 0, checkedAt: now.toISOString(), warnings }, null, 2), 'utf8')
}

// Turns a caught cycle error into the one warning the status file gets that cycle, so a failed
// cycle still writes ok: false rather than leaving the previous cycle's ok: true file in place.
export function cycleFailedWarning(error: unknown): Warning {
    const detail = error instanceof Error ? error.message : String(error)
    return { check: 'cycle-failed', detail }
}

export type IntervalResolution = { ms: number, invalid: boolean }

// A value the operator never set is not a typo, so it resolves quietly to the default. A value
// that is set but is not a finite positive number is the typo case: fall back, but flag it as
// invalid so the caller can log it instead of silently running a hot loop.
export function resolveIntervalMs(raw: string | undefined, fallback = 60_000): IntervalResolution {
    if (raw === undefined || raw === '') return { ms: fallback, invalid: false }
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return { ms: parsed, invalid: false }
    return { ms: fallback, invalid: true }
}
