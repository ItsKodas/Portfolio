// The agent's end of the host rail. Apache runs on the host and this process has no network namespace,
// so the only way to change what Apache serves is to leave a file where a systemd unit will find it.
//
// The sequence number is the whole safety argument. A result carrying an older number is a leftover from
// a request that timed out, and acting on it would mean believing an answer to a different question.

import { posix } from 'node:path'
import { parseApacheResult, REQUEST_FILE, RESULT_FILE, type ApacheAction, type ApacheRequest, type ApacheResult, type ApacheWrite } from '../shared/apache.ts'

export const RAIL_TIMEOUT_MS = 30_000
export const RAIL_POLL_MS = 250

export type RailFs = {
    writeFile(path: string, text: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    readFile(path: string): Promise<string>
    unlink(path: string): Promise<void>
}

export type RailParts = { write: ApacheWrite | null, remove: string[], disable: string[] }

const sleepReal = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// The seq of a request or result file already on disk, or -1 for one that is not there or cannot be
// read. Used only to start this process's counter above whatever a previous one left behind.
function seqIn(text: string): number {
    try {
        const value = (JSON.parse(text) as Record<string, unknown>).seq
        return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : -1
    } catch {
        return -1
    }
}

export class ApacheRail {
    private seq = 0
    private seeded = false
    private queue: Promise<unknown> = Promise.resolve()
    private lastSuccess: number | null = null
    private readonly now: () => number
    private readonly sleep: (ms: number) => Promise<void>

    constructor(
        private readonly dir: string,
        private readonly fs: RailFs,
        options: { now?: () => number, sleep?: (ms: number) => Promise<void> } = {},
    ) {
        this.now = options.now ?? (() => Date.now())
        this.sleep = options.sleep ?? sleepReal
    }

    // How long ago the host unit last answered, not when: the whole point of the figure is the comparison
    // api makes against RAIL_STALE_MS, and an absolute timestamp handed to that comparison is larger than
    // any threshold, so the alarm the spec calls the one that matters most fires forever and teaches the
    // operator to ignore it. The subtraction belongs here, where the clock this class measured with is.
    // null still means the rail has never once been answered.
    ageOfLastSuccess(): number | null {
        return this.lastSuccess === null ? null : this.now() - this.lastSuccess
    }

    // The counter has to keep rising across a restart, not merely within one process. A request that
    // timed out is deliberately left on disk for the unit to answer late, so a fresh process starting
    // again at 0 would take that late answer, to a question it never asked, as its own. The rail
    // directory is the agent state the design asks for a monotonic counter to live in: whatever the
    // files there already carry, the next request is numbered above it.
    private async seed(): Promise<void> {
        if (this.seeded) return
        this.seeded = true
        let highest = -1
        for (const file of [REQUEST_FILE, RESULT_FILE]) {
            const text = await this.fs.readFile(posix.join(this.dir, file)).catch(() => null)
            if (text !== null) highest = Math.max(highest, seqIn(text))
        }
        this.seq = highest + 1
    }

    // Serialised rather than merely awaited by callers: two domain actions arriving together would
    // otherwise write two requests, and the host unit answers one file.
    send(action: ApacheAction, parts: RailParts): Promise<ApacheResult> {
        const run = this.queue.then(() => this.one(action, parts))
        // The queue must not reject, or every later request inherits the failure.
        this.queue = run.catch(() => undefined)
        return run
    }

    private async one(action: ApacheAction, parts: RailParts): Promise<ApacheResult> {
        // Inside the queue, so the read happens once and before any request is numbered.
        await this.seed()
        const seq = this.seq++
        const request: ApacheRequest = { seq, action, ...parts }
        const target = posix.join(this.dir, REQUEST_FILE)
        const staging = `${target}.tmp`
        // Rename, so the unit never sees a half-written request. A path unit fires on the name appearing,
        // and a plain write would make it appear while it is still being filled.
        await this.fs.writeFile(staging, JSON.stringify(request))
        await this.fs.rename(staging, target)

        const deadline = this.now() + RAIL_TIMEOUT_MS
        const resultPath = posix.join(this.dir, RESULT_FILE)
        while (this.now() < deadline) {
            let text: string | null = null
            try {
                text = await this.fs.readFile(resultPath)
            } catch {
                // Not written yet, which is the ordinary case for the first few polls.
            }
            const result = text === null ? null : parseApacheResult(text)
            if (result && result.seq === seq) {
                await this.fs.unlink(resultPath).catch(() => undefined)
                this.lastSuccess = this.now()
                return result
            }
            await this.sleep(RAIL_POLL_MS)
        }
        // The request file is deliberately left where it is. If the unit is merely slow it will still be
        // answered, and the sequence number means that answer is ignored rather than mistaken for the
        // next request's.
        throw new Error(`the Apache host unit did not answer request ${seq} within ${RAIL_TIMEOUT_MS}ms`)
    }
}
