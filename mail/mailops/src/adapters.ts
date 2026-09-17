// Bridges to the world outside the process: the current public address, the DKIM key that docker-mailserver
// generates on its own schedule, and the alias map we own. Parsing is pure; the IO around it is one line.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'

const TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace'

export function parseTrace(body: string): string {
    const match = body.match(/^ip=(.+)$/m)
    if (!match?.[1]) throw new Error('Could not determine public IP from the trace response')
    return match[1].trim()
}

// Cloudflare's own endpoint, so the address we publish and the service we publish it to agree, and no third
// party sits in the loop.
export async function fetchPublicIp(fetchImpl: typeof fetch = fetch): Promise<string> {
    const response = await fetchImpl(TRACE_URL)
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

// The delivery seam. Only 'forward' is implemented in this phase; 'ingest' is recognised and deliberately
// produces nothing, so adding it later is additive rather than a rewrite.
export function aliasMap(config: Config): string {
    if (!config.deliveryTargets.includes('forward')) return ''
    return [
        `contact@${config.mailDomain} ${config.forwardTo}`,
        `@${config.mailDomain} ${config.forwardTo}`,
    ].join('\n') + '\n'
}

export async function writeAliasMap(configDir: string, config: Config): Promise<void> {
    const path = join(configDir, 'postfix-virtual.cf')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, aliasMap(config), 'utf8')
}
