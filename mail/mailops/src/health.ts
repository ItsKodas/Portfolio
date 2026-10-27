// Two tiers, split on one rule: never fail closed on a condition whose failure mode is lost mail. Config
// errors knowable before we accept anything stop the process. Everything environmental warns and keeps running,
// because a stack that kills itself over a closed port receives nothing while the port is closed.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SmtpProbe, SpamhausResult, InboundResult } from './probes.ts'
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
    // True only when Cloudflare answered and refused. A request that never got an answer leaves this
    // false, because an unanswered request says nothing about whether the credentials are good.
    cloudflareRejected?: boolean
}

export function evaluateBootGate(checks: BootChecks): string[] {
    const failures: string[] = []
    if (!checks.outbound.ok) failures.push(`outbound port 25 is unreachable: ${checks.outbound.error ?? 'no banner'}`)
    if (!checks.publicIp) failures.push('public IP could not be determined')
    if (!checks.cloudflareOk) {
        failures.push(checks.cloudflareRejected
            ? 'Cloudflare rejected CF_API_TOKEN or CF_ZONE_ID'
            : 'the Cloudflare API could not be reached')
    }
    return failures
}

// The spec's whole two-tier principle is "never fail closed on a condition whose failure mode is lost
// mail", and hard-exiting on a momentarily unreachable network breaks it: a crash-looping mailops on a
// dynamic IP means the A record goes stale, and after the next rotation inbound mail stops. Everything
// environmental here is worth retrying. A credential Cloudflare has actively rejected is not: that is
// genuine misconfiguration, retrying cannot help it, and failing fast is the correct answer.
// (A malformed MAIL_DOMAIN never reaches this point; loadConfig throws first.)
export function bootGateIsRetryable(checks: BootChecks): boolean {
    return !checks.cloudflareRejected
}

// An advisory warning is reported and logged but does not flip ok, so it never makes the container
// unhealthy. Everything else does. Advisory exists for the early half of a two-step alarm: something worth
// looking at this week, before it becomes the failing version of itself.
export type Warning = { check: string, detail: string, advisory?: boolean }

export type StatusInput = {
    reconcile: ReconcileResult
    spamhaus: SpamhausResult
    lastInbound: Date | null
    now: Date
    inboundStaleAfterHours?: number
    logError?: string | null
    certError?: string | null
    cert?: CertStatus | null
    inbound?: InboundResult | null
    inboundInconclusiveStreak?: number
}

// How many inconclusive inbound checks in a row before saying the check itself has gone blind. One or two
// is check-host having a moment; three, at a 15 minute cadence, is most of an hour with no real answer.
export const INBOUND_INCONCLUSIVE_LIMIT = 3

export const RESTART_MAILSERVER_COMMAND = 'docker compose restart mailserver'

// Renewal starts with 30 days left (day 60 of 90). Nine days of failed attempts is no longer a blip, so it
// is reported; with 10 days left it fails the healthcheck, which still leaves time to fix it by hand.
export const CERT_WARN_DAYS = 21
export const CERT_FAIL_DAYS = 10

// The changedetector polls every couple of seconds, but mailops probes in the same cycle that lego renewed
// in. A mismatch that young is the reload still on its way, not a reload that never happened.
export const CERT_RELOAD_GRACE_MS = 5 * 60_000

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

    // The file on disk is what mailserver should be serving; the probe says what it is serving. They part
    // ways when a renewal lands and the changedetector does not reload Postfix, and left alone the
    // certificate on the wire then expires around day 90 while the file looks perfectly healthy.
    const cert = input.cert
    const onDisk = cert?.onDiskNotAfter ?? null
    const served = cert?.servedNotAfter ?? null
    if (cert?.servedError) {
        warnings.push({
            check: 'cert-served-unknown',
            detail: `could not read the certificate mailserver is serving: ${cert.servedError}`,
        })
    }
    if (onDisk && served && onDisk.getTime() !== served.getTime()) {
        const changedAt = cert?.onDiskChangedAt
        const settling = changedAt && input.now.getTime() - changedAt.getTime() < CERT_RELOAD_GRACE_MS
        if (!settling) {
            warnings.push({
                check: 'cert-reload-needed',
                detail: `mailserver is serving a certificate expiring ${served.toISOString()}, but the certificate on disk expires ${onDisk.toISOString()}, so Postfix did not reload after the renewal. From the mail directory, run: ${RESTART_MAILSERVER_COMMAND}`,
            })
        }
    }

    // Judged against the clock, not against another file. A renewal that keeps failing quietly between
    // backoff attempts, or a lego run that "succeeds" without replacing anything, otherwise leaves an
    // expiring certificate behind ok: true. The earlier of the two is the one that bites first.
    const expiries = [onDisk, served].filter((d): d is Date => d !== null)
    if (expiries.length > 0) {
        const soonest = new Date(Math.min(...expiries.map(d => d.getTime())))
        const daysLeft = (soonest.getTime() - input.now.getTime()) / 86_400_000
        const which = served && soonest.getTime() === served.getTime() ? 'the certificate mailserver is serving' : 'the certificate on disk'
        if (daysLeft <= 0) {
            warnings.push({ check: 'cert-expired', detail: `${which} expired ${soonest.toISOString()}` })
        } else if (daysLeft < CERT_WARN_DAYS) {
            warnings.push({
                check: 'cert-expiring',
                detail: `${which} expires ${soonest.toISOString()}, in ${Math.floor(daysLeft)} days, and renewal should have replaced it by now`,
                ...(daysLeft >= CERT_FAIL_DAYS ? { advisory: true } : {}),
            })
        }
    }

    // A log we cannot read looks exactly like a log with nothing in it, which silently disables the
    // inbound-staleness check below: the only real evidence that inbound 25 still reaches us.
    if (input.logError) {
        warnings.push({ check: 'log-unreadable', detail: `${input.logError}, so inbound staleness cannot be checked` })
    }

    // Loud, never fatal. Refusing to run over this would stop DNS updates on a dynamic IP, so after the next
    // rotation inbound mail would stop entirely: a worse outcome than the one being warned about.
    if (input.inbound && !input.inbound.inconclusive && !input.inbound.reachable) {
        warnings.push({ check: 'inbound-unreachable', detail: `${input.inbound.detail}. Check the modem's port 25 forward` })
    }

    // An outside check that keeps failing to answer must not read as a passing one. Without this the
    // status file stays ok: true while nothing is actually checking inbound 25 at all.
    if ((input.inboundInconclusiveStreak ?? 0) >= INBOUND_INCONCLUSIVE_LIMIT) {
        warnings.push({
            check: 'inbound-check-unavailable',
            detail: `the outside inbound 25 check has been inconclusive ${input.inboundInconclusiveStreak} times running, so inbound 25 is currently unverified`,
        })
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
    await writeFile(path, JSON.stringify({ ok: warnings.every(w => w.advisory), checkedAt: now.toISOString(), warnings }, null, 2), 'utf8')
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
