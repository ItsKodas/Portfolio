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

export class ApacheRail {
    private seq = 0
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

    lastSuccessAt(): number | null {
        return this.lastSuccess
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
