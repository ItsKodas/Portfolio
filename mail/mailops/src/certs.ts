// DNS-01 rather than HTTP-01, deliberately: no inbound HTTP to expose, and renewal does not break when the
// public IP rotates. The challenge dance itself is lego's job. Delegating it keeps custom code off the path
// where custom code is least welcome.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import type { Config } from './config.ts'

const run = promisify(execFile)
const RENEWAL_WINDOW_DAYS = 30

export function needsRenewal(notAfter: Date | null, now: Date, windowDays = RENEWAL_WINDOW_DAYS): boolean {
    if (!notAfter) return true
    const daysLeft = (notAfter.getTime() - now.getTime()) / 86_400_000
    return daysLeft < windowDays
}

export function legoArgs(config: Config, certDir: string): string[] {
    return [
        '--accept-tos',
        '--email', config.dmarcRua,
        '--dns', 'cloudflare',
        '--domains', config.mailHostname,
        '--path', certDir,
        'run',
    ]
}

async function currentNotAfter(config: Config, certDir: string): Promise<Date | null> {
    try {
        const pem = await readFile(join(certDir, 'certificates', `${config.mailHostname}.crt`), 'utf8')
        return new Date(new X509Certificate(pem).validTo)
    } catch {
        return null
    }
}

export async function ensureCertificate(config: Config, certDir: string, now: Date): Promise<void> {
    const notAfter = await currentNotAfter(config, certDir)
    if (!needsRenewal(notAfter, now)) return

    const args = notAfter
        ? legoArgs(config, certDir).map(arg => arg === 'run' ? 'renew' : arg)
        : legoArgs(config, certDir)

    // lego reads the Cloudflare credential from CF_DNS_API_TOKEN, so the same scoped token serves both the
    // record reconciliation and the certificate challenge.
    await run('lego', args, { env: { ...process.env, CF_DNS_API_TOKEN: config.cfApiToken } })
}
