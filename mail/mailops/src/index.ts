// Boot gate once, then reconcile forever. The loop is deliberately the same code path as the initial setup.

import { loadConfig } from './config.ts'
import { desiredRecords } from './desired.ts'
import { createCloudflareApi } from './cloudflare.ts'
import { reconcile, createWriteTracker } from './reconcile.ts'
import { fetchPublicIp, readDkimKey, writeAliasMap, readLogTail } from './adapters.ts'
import { probeOutboundSmtp, checkSpamhaus, lastInboundConnection } from './probes.ts'
import type { SpamhausResult } from './probes.ts'
import { evaluateBootGate, collectWarnings, writeStatus, cycleFailedWarning, resolveIntervalMs, BootGateError } from './health.ts'
import { ensureCertificate } from './certs.ts'

const log = (message: string) => console.log(`[mailops] ${new Date().toISOString()} ${message}`)

const CONFIG_DIR = process.env.MAIL_CONFIG_DIR ?? '/mail-config'
const LOG_FILE = process.env.MAIL_LOG_FILE ?? '/mail-logs/mail.log'
const STATUS_FILE = process.env.MAILOPS_STATUS_FILE ?? '/health/status.json'
const CERT_DIR = process.env.MAIL_CERT_DIR ?? '/mail-certs'
const OUTBOUND_PROBE_HOST = process.env.MAILOPS_PROBE_HOST ?? 'gmail-smtp-in.l.google.com'

// A malformed value here is a configuration error knowable before we accept anything, but
// crashing the loop over it is the wrong response: fall back and log, rather than let a typo
// turn setTimeout(NaN) into a hot loop that hammers Cloudflare every tick.
const intervalResolution = resolveIntervalMs(process.env.MAILOPS_INTERVAL_MS)
if (intervalResolution.invalid) {
    log(`WARN invalid MAILOPS_INTERVAL_MS=${process.env.MAILOPS_INTERVAL_MS}, falling back to ${intervalResolution.ms}ms`)
}
const INTERVAL_MS = intervalResolution.ms

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

    // Lives across cycles on purpose: it is what notices a record being rewritten every single cycle
    // without ever converging, which reconcile itself cannot see from one pass.
    const writeTracker = createWriteTracker()

    let lastIp: string | null = null
    // Genuinely unknown until the first real lookup runs below, which happens unconditionally on the
    // first cycle since lastIp starts null. Never overwritten with a fabricated value afterward: it
    // only changes when checkSpamhaus actually runs, so a listing found once keeps being reported
    // in status.json until a later real lookup clears it.
    let lastSpamhaus: SpamhausResult = { listed: false, inconclusive: true, codes: [], meanings: [] }

    for (;;) {
        let warnings
        try {
            const ip = await fetchPublicIp()
            const dkim = await readDkimKey(CONFIG_DIR, config)
            const result = await reconcile(api, desiredRecords(config, ip, dkim), writeTracker)

            if (result.created.length || result.updated.length) {
                log(`created=[${result.created}] updated=[${result.updated}]`)
            }

            // Only on change: a rotated address can arrive carrying a previous occupant's XBL listing, and that
            // is something to find out from a log line rather than from mail quietly failing.
            if (ip !== lastIp) {
                lastSpamhaus = await checkSpamhaus(ip)
                log(`public IP is ${ip}, spamhaus: ${lastSpamhaus.listed ? lastSpamhaus.meanings.join('; ') : 'not listed'}`)
                lastIp = ip
            }

            await ensureCertificate(config, CERT_DIR, new Date())

            const tail = await readLogTail(LOG_FILE)
            warnings = collectWarnings({
                reconcile: result, spamhaus: lastSpamhaus, lastInbound: lastInboundConnection(tail.text),
                logError: tail.error ?? null, now: new Date(),
            })
            for (const warning of warnings) log(`WARN ${warning.check}: ${warning.detail}`)
        } catch (error) {
            // A failed cycle must never stop the loop. Mail keeps flowing while DNS or certificates are broken.
            // It must also not leave the previous cycle's ok: true status behind: the health file is the only
            // signal an operator (or the container healthcheck) has that a cycle is failing.
            log(`ERROR cycle failed: ${(error as Error).message}`)
            warnings = [cycleFailedWarning(error)]
        }
        try {
            await writeStatus(STATUS_FILE, warnings, new Date())
        } catch (error) {
            // The status file is the signal, not the mail path. A read-only or full /health mount must not be
            // able to kill the loop that keeps DNS reconciled and mail flowing: log it and move on.
            log(`ERROR failed to write status file: ${(error as Error).message}`)
        }
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS))
    }
}

main().catch(error => {
    console.error(error instanceof BootGateError ? error.message : error)
    process.exit(1)
})
