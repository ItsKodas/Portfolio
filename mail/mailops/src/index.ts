// Boot gate once, then reconcile forever. The loop is deliberately the same code path as the initial setup.

import { readFile } from 'node:fs/promises'
import { loadConfig } from './config.ts'
import { desiredRecords } from './desired.ts'
import { createCloudflareApi } from './cloudflare.ts'
import { reconcile } from './reconcile.ts'
import { fetchPublicIp, readDkimKey, writeAliasMap } from './adapters.ts'
import { probeOutboundSmtp, checkSpamhaus, lastInboundConnection } from './probes.ts'
import { evaluateBootGate, collectWarnings, writeStatus, BootGateError } from './health.ts'
import { ensureCertificate } from './certs.ts'

const CONFIG_DIR = process.env.MAIL_CONFIG_DIR ?? '/mail-config'
const LOG_FILE = process.env.MAIL_LOG_FILE ?? '/mail-logs/mail.log'
const STATUS_FILE = process.env.MAILOPS_STATUS_FILE ?? '/health/status.json'
const CERT_DIR = process.env.MAIL_CERT_DIR ?? '/mail-certs'
const INTERVAL_MS = Number(process.env.MAILOPS_INTERVAL_MS ?? 60_000)
const OUTBOUND_PROBE_HOST = process.env.MAILOPS_PROBE_HOST ?? 'gmail-smtp-in.l.google.com'

const log = (message: string) => console.log(`[mailops] ${new Date().toISOString()} ${message}`)

async function main() {
    const config = loadConfig(process.env)
    log(`domain=${config.mailDomain} hostname=${config.mailHostname} relay=${config.relay ? config.relay.host : 'direct'}`)

    const api = createCloudflareApi(config.cfApiToken, config.cfZoneId)

    const outbound = await probeOutboundSmtp(OUTBOUND_PROBE_HOST)
    let publicIp: string | null = null
    try { publicIp = await fetchPublicIp() } catch { publicIp = null }
    let cloudflareOk = true
    try { await api.list(config.mailHostname, 'A') } catch { cloudflareOk = false }

    const failures = evaluateBootGate({ outbound, publicIp, cloudflareOk })
    if (failures.length > 0) throw new BootGateError(failures)
    log(`boot gate passed, banner: ${outbound.banner}`)

    await writeAliasMap(CONFIG_DIR, config)

    let lastIp: string | null = null
    for (;;) {
        try {
            const ip = await fetchPublicIp()
            const dkim = await readDkimKey(CONFIG_DIR, config)
            const result = await reconcile(api, desiredRecords(config, ip, dkim))

            if (result.created.length || result.updated.length) {
                log(`created=[${result.created}] updated=[${result.updated}]`)
            }

            // Only on change: a rotated address can arrive carrying a previous occupant's XBL listing, and that
            // is something to find out from a log line rather than from mail quietly failing.
            const spamhaus = ip === lastIp
                ? { listed: false, inconclusive: true, codes: [], meanings: [] }
                : await checkSpamhaus(ip)
            if (ip !== lastIp) {
                log(`public IP is ${ip}, spamhaus: ${spamhaus.listed ? spamhaus.meanings.join('; ') : 'not listed'}`)
                lastIp = ip
            }

            await ensureCertificate(config, CERT_DIR, new Date())

            const logText = await readFile(LOG_FILE, 'utf8').catch(() => '')
            const warnings = collectWarnings({
                reconcile: result, spamhaus, lastInbound: lastInboundConnection(logText), now: new Date(),
            })
            for (const warning of warnings) log(`WARN ${warning.check}: ${warning.detail}`)
            await writeStatus(STATUS_FILE, warnings, new Date())
        } catch (error) {
            // A failed cycle must never stop the loop. Mail keeps flowing while DNS or certificates are broken.
            log(`ERROR cycle failed: ${(error as Error).message}`)
        }
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
    }
}

main().catch(error => {
    console.error(error instanceof BootGateError ? error.message : error)
    process.exit(1)
})
