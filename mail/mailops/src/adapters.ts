// Bridges to the world outside the process: the current public address, the DKIM key that docker-mailserver
// generates on its own schedule, and the alias map we own. Parsing is pure; the IO around it is one line.

import { readFile, writeFile, mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'

const TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace'

// Undici defaults to 300 seconds. A stalled request would freeze a cycle for five intervals with no log
// line and no status write, leaving the healthcheck reading a stale ok: true the whole time.
export const REQUEST_TIMEOUT_MS = 15_000

export function parseTrace(body: string): string {
    const match = body.match(/^ip=(.+)$/m)
    if (!match?.[1]) throw new Error('Could not determine public IP from the trace response')
    return match[1].trim()
}

// Cloudflare's own endpoint, so the address we publish and the service we publish it to agree, and no third
// party sits in the loop.
export async function fetchPublicIp(fetchImpl: typeof fetch = fetch): Promise<string> {
    const response = await fetchImpl(TRACE_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    return parseTrace(await response.text())
}

// OpenDKIM writes a BIND fragment with the key split across quoted chunks. Rejoin them into the single
// string a TXT record needs.
export function parseDkimRecord(bind: string): string | null {
    const chunks = bind.match(/"([^"]*)"/g)
    if (!chunks || chunks.length === 0) return null
    const joined = chunks.map(c => c.slice(1, -1)).join('')
    return joined.trim() === '' ? null : joined
}

// Returns null while the key does not exist yet. docker-mailserver generates it on first start, so the first
// few cycles legitimately find nothing and simply publish the rest of the records. Other filesystem errors are
// logged to stderr but still return null, never throwing, so the deployment degrades gracefully.
export async function readDkimKey(configDir: string, config: Config): Promise<string | null> {
    const path = join(configDir, 'opendkim', 'keys', config.mailDomain, `${config.dkimSelector}.txt`)
    try {
        return parseDkimRecord(await readFile(path, 'utf8'))
    } catch (err) {
        // ENOENT is the normal state before docker-mailserver generates the key. Log nothing for it.
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
            return null
        }
        // Any other error is an anomaly (permissions, path is a directory, etc). Warn the operator.
        const errorCode = err instanceof Error && 'code' in err ? err.code : 'unknown'
        console.warn(`Warning: cannot read DKIM key from ${path}: ${errorCode}`)
        return null
    }
}

// Only the most recent matching line is ever wanted, so reading the whole file is pure waste: the Postfix
// log grows unbounded between weekly logrotates, and this runs every 60 seconds in a container with no
// memory limit. Read the tail with a positioned read instead.
export const LOG_TAIL_BYTES = 256 * 1024

export type LogTail = { text: string, error?: string }

export async function readLogTail(path: string, maxBytes = LOG_TAIL_BYTES): Promise<LogTail> {
    let handle
    try {
        handle = await open(path, 'r')
    } catch (err) {
        const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
        // A freshly deployed stack has no log yet, and that is not a fault. Anything else (a wrong
        // MAIL_LOG_FILE above all) is, and it must not be indistinguishable from the normal case: a
        // silently empty log means lastInboundConnection returns null forever and the inbound-stale
        // check, the only real evidence that inbound 25 works, quietly never fires again.
        if (code === 'ENOENT') return { text: '' }
        return { text: '', error: `cannot open ${path}: ${code}` }
    }

    try {
        const stats = await handle.stat()
        // A directory or a device where the log should be reads as empty on some platforms and throws on
        // others. Checking the type makes a misconfigured MAIL_LOG_FILE report the same way everywhere.
        if (!stats.isFile()) return { text: '', error: `${path} is not a regular file` }
        const size = stats.size
        const length = Math.min(size, maxBytes)
        if (length <= 0) return { text: '' }
        const start = size - length
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, start)
        let text = buffer.subarray(0, bytesRead).toString('utf8')
        // A positioned read almost certainly lands mid-line. Drop that fragment so a truncated
        // timestamp can never be parsed into a bogus connection time.
        if (start > 0) {
            const newline = text.indexOf('\n')
            text = newline >= 0 ? text.slice(newline + 1) : ''
        }
        return { text }
    } catch (err) {
        const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
        return { text: '', error: `cannot read ${path}: ${code}` }
    } finally {
        await handle.close().catch(() => {})
    }
}

// The delivery seam. Only 'forward' is implemented in this phase; 'ingest' is recognised and deliberately
// produces nothing, so adding it later is additive rather than a rewrite.
export function aliasMap(config: Config): string {
    if (!config.deliveryTargets.includes('forward')) return ''
    const lines = [`contact@${config.mailDomain} ${config.forwardTo}`]
    // contact@ is the only address the design ever authorised. A catch-all on a forward-only server
    // accepts every dictionary-attack recipient and re-sends it to the operator's real inbox from an
    // address that is permanently on the PBL, which risks the operator's own provider rate-limiting
    // the single delivery path this whole design depends on. Opt in knowingly or not at all.
    if (config.acceptCatchall) lines.push(`@${config.mailDomain} ${config.forwardTo}`)
    return lines.join('\n') + '\n'
}

export async function writeAliasMap(configDir: string, config: Config): Promise<void> {
    const path = join(configDir, 'postfix-virtual.cf')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, aliasMap(config), 'utf8')
}
