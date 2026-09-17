// Two tiers, split on one rule: never fail closed on a condition whose failure mode is lost mail. Config
// errors knowable before we accept anything stop the process. Everything environmental warns and keeps running,
// because a stack that kills itself over a closed port receives nothing while the port is closed.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SmtpProbe, SpamhausResult } from './probes.ts'
import type { ReconcileResult } from './reconcile.ts'

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
}

export function collectWarnings(input: StatusInput): Warning[] {
    const warnings: Warning[] = []
    const staleAfter = input.inboundStaleAfterHours ?? 48

    if (input.reconcile.conflicts.length > 0) {
        warnings.push({
            check: 'dns-conflict',
            detail: `records not maintained because something unmanaged is in the way: ${input.reconcile.conflicts.join(', ')}`,
        })
    }

    // Inconclusive is not a listing. Warning on it would fire every cycle behind a public resolver.
    if (input.spamhaus.listed) {
        warnings.push({ check: 'spamhaus', detail: input.spamhaus.meanings.join('; ') })
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
