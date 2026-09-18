// Boot gate once, then reconcile forever. The loop is deliberately the same code path as the initial setup.

import { loadConfig } from './config.ts'
import { desiredRecords } from './desired.ts'
import { createCloudflareApi, CloudflareApiError, type DnsApi } from './cloudflare.ts'
import { reconcile, createWriteTracker } from './reconcile.ts'
import { fetchPublicIp, readDkimKey, writeAliasMap, readLogTail } from './adapters.ts'
import { probeOutboundSmtp, checkSpamhaus, lastInboundConnection, checkInboundPort } from './probes.ts'
import type { SpamhausResult, InboundResult } from './probes.ts'
import { evaluateBootGate, bootGateIsRetryable, collectWarnings, writeStatus, cycleFailedWarning, resolveIntervalMs, BootGateError, type BootChecks } from './health.ts'
import type { Config } from './config.ts'
import { ensureCertificate, certificateStatus } from './certs.ts'

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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Roughly 75 seconds of patience in total. Long enough to ride out a modem still negotiating or a DNS
// resolver that is not answering yet, short enough that a genuinely broken deployment still tells the
// operator so promptly.
const BOOT_GATE_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000]

// The outside inbound 25 check calls a free third-party service. Every 60 second cycle would be roughly 1,440
// calls a day with no published limit, which is the fastest way to get this IP blocked and every later check
// stuck at inconclusive. Fifteen minutes still finds a broken port forward within the hour, against the
// 48 hours the log-staleness check needs.
const INBOUND_CHECK_INTERVAL_MS = 15 * 60_000

async function probeEnvironment(api: DnsApi, config: Config): Promise<BootChecks> {
    const outbound = await probeOutboundSmtp(OUTBOUND_PROBE_HOST)

    let publicIp: string | null = null
    try { publicIp = await fetchPublicIp() } catch { publicIp = null }

    let cloudflareOk = true
    let cloudflareRejected = false
    try {
        await api.list(config.mailHostname, 'A')
    } catch (error) {
        cloudflareOk = false
        // Only a refusal Cloudflare actually issued counts as a rejected credential. A request that
        // never got an answer says nothing about the token, and retrying it is the right response.
        cloudflareRejected = error instanceof CloudflareApiError
    }

    return { outbound, publicIp, cloudflareOk, cloudflareRejected }
}

// evaluateBootGate stays pure; the retrying lives out here so it stays that way.
async function passBootGate(api: DnsApi, config: Config): Promise<BootChecks> {
    for (let attempt = 0; ; attempt++) {
        const checks = await probeEnvironment(api, config)
        const failures = evaluateBootGate(checks)
        if (failures.length === 0) return checks

        const lastAttempt = attempt >= BOOT_GATE_BACKOFF_MS.length
        if (lastAttempt || !bootGateIsRetryable(checks)) throw new BootGateError(failures)

        const wait = BOOT_GATE_BACKOFF_MS[attempt]!
        log(`WARN boot gate attempt ${attempt + 1} failed (${failures.join('; ')}), retrying in ${wait / 1000}s`)
        await sleep(wait)
    }
}

async function main() {
    const config = loadConfig(process.env)
    log(`domain=${config.mailDomain} hostname=${config.mailHostname} relay=${config.relay ? config.relay.host : 'direct'}`)

    const api = createCloudflareApi(config.cfApiToken, config.cfZoneId)

    const checks = await passBootGate(api, config)
    log(`boot gate passed, banner: ${checks.outbound.banner}`)

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

    // Same retention rule as lastSpamhaus: only a conclusive answer replaces it, so one check-host hiccup
    // cannot clear an "unreachable" that is still true. Inconclusive answers are counted separately instead.
    let lastInboundCheck: InboundResult | null = null
    let lastInboundCheckAt = 0
    let inboundInconclusiveStreak = 0

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
            const ipChanged = ip !== lastIp
            if (ipChanged) {
                lastSpamhaus = await checkSpamhaus(ip)
                log(`public IP is ${ip}, spamhaus: ${lastSpamhaus.listed ? lastSpamhaus.meanings.join('; ') : 'not listed'}`)
                lastIp = ip
            }

            // Also on every IP change, not just on the timer: a modem reboot is the likeliest thing to both
            // rotate the address and drop the port forward, so that is exactly when to look again.
            if (ipChanged || Date.now() - lastInboundCheckAt >= INBOUND_CHECK_INTERVAL_MS) {
                const inbound = await checkInboundPort(ip, 25)
                lastInboundCheckAt = Date.now()
                if (inbound.inconclusive) {
                    inboundInconclusiveStreak++
                } else {
                    lastInboundCheck = inbound
                    inboundInconclusiveStreak = 0
                }
                const verdict = inbound.inconclusive ? 'inconclusive' : inbound.reachable ? 'reachable' : 'UNREACHABLE'
                log(`inbound 25 from outside: ${verdict} (${inbound.detail})`)
            }

            const tail = await readLogTail(LOG_FILE)

            // Deliberately after the log read, and in its own try/catch. Certificate trouble used to abort
            // the whole cycle, so status.json collapsed to a single generic cycle-failed warning and the
            // Spamhaus state, the DNS conflict list and the inbound-staleness check all disappeared with
            // it. A failing renewal is its own degrade-and-shout condition, not a reason to go blind.
            let certError: string | null = null
            try {
                await ensureCertificate(config, CERT_DIR, new Date())
            } catch (error) {
                certError = (error as Error).message
            }
            const cert = await certificateStatus(config, CERT_DIR)

            warnings = collectWarnings({
                reconcile: result, spamhaus: lastSpamhaus, lastInbound: lastInboundConnection(tail.text),
                logError: tail.error ?? null, certError, cert, now: new Date(),
                inbound: lastInboundCheck, inboundInconclusiveStreak,
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
        await sleep(INTERVAL_MS)
    }
}

main().catch(error => {
    console.error(error instanceof BootGateError ? error.message : error)
    process.exit(1)
})
