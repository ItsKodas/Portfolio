// Every TCP port listening on the host, read from the host's own network namespace. The agent has
// network_mode: none, so it cannot probe the host by binding: it would only ever see its own empty
// namespace. What it does have is Docker, so it runs a throwaway container in the host's namespace
// (--network host) that reads /proc/net/tcp and tcp6 (when the host has one) and exits. That lists
// Apache, databases, and anything else a person started by hand, which is exactly what Docker's own
// published-port view cannot see.
//
// The container runs the agent's own image, looked up from the agent's own container, so nothing is
// ever pulled (the agent is offline) and a rebuild never leaves this on a stale tag. Docker's published
// ports are added on top: with the userland proxy off a published port has no listener of its own, and
// a container that is still starting has its port reserved before anything listens on it.

import { randomBytes } from 'node:crypto'

import { describeError } from '../shared/formats.ts'
import { tail, type Runner } from './compose.ts'

export const PROBE_TIMEOUT_MS = 10_000
const INSPECT_TIMEOUT_MS = 15_000
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/
const LISTEN = '0A'

export type Listening = { ok: true, ports: ReadonlySet<number> } | { ok: false, problem: string }

export type HostPortDeps = {
    runner: Runner
    // The agent's own container, whose image the probe runs
    container: string
    // Docker's published ports, read fresh on every call
    published: () => Promise<Set<number>>
    newName?: () => string
    now?: () => number
    // How long one reading answers every caller. The portal's live check asks for a suggestion and a
    // verdict back to back, and that should cost one probe, not two.
    cacheMs?: number
}

// Rows are `sl local rem st ...`, local is HEXADDR:HEXPORT. The header row has no colon-separated port
// and is skipped by the state check, as is anything that is not a listing at all.
export function parseProcNetTcp(text: string): Set<number> {
    const ports = new Set<number>()
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 4 || fields[3] !== LISTEN) continue
        const local = fields[1] ?? ''
        const hex = local.slice(local.lastIndexOf(':') + 1)
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) continue
        ports.add(Number.parseInt(hex, 16))
    }
    return ports
}

// Through sh rather than cat alone: a host with IPv6 disabled has no /proc/net/tcp6, and cat would exit
// 1 on it and fail every probe. The trailing true keeps that from mattering, so an exit that is not 0 is
// Docker's own (a missing image, a daemon that refused), and a tcp that could not be read either leaves
// the listing empty, which read() below still refuses.
export function probeArgv(image: string, name: string): string[] {
    return [
        'run', '--rm', '--name', name, '--network', 'host', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pull', 'never', '--entrypoint', 'sh', image,
        '-c', 'cat /proc/net/tcp; cat /proc/net/tcp6 2>/dev/null; true',
    ]
}

export function createHostPortReader(deps: HostPortDeps): () => Promise<Listening> {
    const newName = deps.newName ?? (() => `hostd-port-probe-${randomBytes(4).toString('hex')}`)
    const now = deps.now ?? Date.now
    const cacheMs = deps.cacheMs ?? 2000
    let image: string | null = null
    let cached: { at: number, reading: Promise<Listening> } | null = null

    async function ownImage(): Promise<string | { problem: string }> {
        if (image) return image
        const result = await deps.runner('docker', ['inspect', '--format', '{{.Image}}', deps.container], INSPECT_TIMEOUT_MS)
        const id = result.stdout.trim()
        if (result.exitCode !== 0 || !IMAGE_ID.test(id)) {
            return { problem: `could not read the host's ports: ${deps.container}'s image could not be read: ${tail(result.stderr.trim(), 300)}` }
        }
        image = id
        return id
    }

    async function read(): Promise<Listening> {
        const found = await ownImage()
        if (typeof found !== 'string') return { ok: false, problem: found.problem }

        const name = newName()
        const result = await deps.runner('docker', probeArgv(found, name), PROBE_TIMEOUT_MS)
        if (result.timedOut || result.exitCode !== 0) {
            // --rm only removes a container that exits; one killed with its CLI is left behind otherwise
            await deps.runner('docker', ['rm', '-f', name], INSPECT_TIMEOUT_MS).catch(() => undefined)
            const why = result.timedOut ? 'the probe timed out' : tail(result.stderr.trim(), 300)
            return { ok: false, problem: `could not read the host's ports: ${why}` }
        }
        const ports = parseProcNetTcp(result.stdout)
        if (ports.size === 0) return { ok: false, problem: 'could not read the host\'s ports: the listing was empty' }

        try {
            for (const port of await deps.published()) ports.add(port)
        } catch (error) {
            return { ok: false, problem: `could not read Docker's published ports: ${describeError(error)}` }
        }
        return { ok: true, ports }
    }

    return () => {
        if (cached && now() - cached.at < cacheMs) return cached.reading
        const reading = read()
        cached = { at: now(), reading }
        // A failed reading is not kept: the next caller should try again rather than inherit it
        void reading.then(seen => { if (!seen.ok && cached?.reading === reading) cached = null })
        return reading
    }
}
