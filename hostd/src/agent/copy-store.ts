// The record of copies from live into another environment: one JSON file in the agent's state directory,
// the last COPY_KEEP runs of each environment, written atomically on every change like the backup history.
//
// A write that fails never costs the caller its record: the copy is under way or over by the time this is
// called, so the in-memory list changes first and a failed write is a logged warning, not a thrown error.
// A run is visible the moment start() is called, before its write lands, which is what lets the agent
// answer a start with a run id the portal can poll at once.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

import { describeError, isRecord } from '../shared/formats.ts'
import type { CopyRecord } from '../shared/protocol.ts'

export type { CopyRecord } from '../shared/protocol.ts'

export const COPY_KEEP = 20
export const INTERRUPTED_REASON = 'the agent restarted during the copy'

export type CopyStoreFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(dir: string): Promise<void>
}

const nodeFs: CopyStoreFs = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    rename: (from, to) => rename(from, to),
    mkdir: async dir => { await mkdir(dir, { recursive: true }) },
}

type Saved = { runs: CopyRecord[] }

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string')
const isTextOrNull = (value: unknown): boolean => value === null || typeof value === 'string'

function isCopyRecord(value: unknown): value is CopyRecord {
    return isRecord(value)
        && typeof value.project === 'string' && typeof value.environment === 'string'
        && typeof value.run === 'string' && typeof value.actor === 'string'
        && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
        && typeof value.durationMs === 'number'
        && (value.outcome === 'ok' || value.outcome === 'failed' || value.outcome === 'running')
        && isTextOrNull(value.step) && isTextOrNull(value.reason)
        && isStrings(value.services) && isStrings(value.storage)
}

const sameEnvironment = (entry: CopyRecord, project: string, environment: string): boolean =>
    entry.project === project && entry.environment === environment

export class CopyStore {
    // Newest first, across every environment
    private runs: CopyRecord[] = []
    private problem: string | null = null
    // One write at a time, so two runs finishing together cannot lose one another's change
    private queue: Promise<unknown> = Promise.resolve()

    constructor(
        private readonly path: string,
        private readonly fs: CopyStoreFs = nodeFs,
        private readonly log: (message: string) => void = () => {},
    ) {}

    // Never throws: a missing file is a machine that has never copied anything.
    async load(): Promise<void> {
        let text: string
        try {
            text = await this.fs.readFile(this.path)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
            this.warn(`the copy history at ${this.path} could not be read: ${describeError(error)}`)
            return
        }
        try {
            const saved = JSON.parse(text) as Partial<Saved>
            if (!isRecord(saved) || !Array.isArray(saved.runs)) throw new Error('the file is not a copy history')
            this.runs = saved.runs.filter(isCopyRecord)
        } catch (error) {
            this.warn(`the copy history at ${this.path} could not be read: ${describeError(error)}`)
        }
    }

    private warn(problem: string): void {
        this.problem = problem
        this.log(`WARN ${problem}`)
    }

    warnings(): string[] {
        return this.problem ? [this.problem] : []
    }

    list(project: string, environment: string): CopyRecord[] {
        return this.runs.filter(entry => sameEnvironment(entry, project, environment))
    }

    get(project: string, environment: string, run: string): CopyRecord | null {
        return this.runs.find(entry => sameEnvironment(entry, project, environment) && entry.run === run) ?? null
    }

    // A new run, newest first. Older runs of the same environment beyond COPY_KEEP are dropped.
    start(record: CopyRecord): Promise<void> {
        let kept = 0
        this.runs = [record, ...this.runs].filter(entry => {
            if (!sameEnvironment(entry, record.project, record.environment)) return true
            kept += 1
            return kept <= COPY_KEEP
        })
        return this.save()
    }

    // The same run, finished
    finish(record: CopyRecord): Promise<void> {
        this.runs = this.runs.map(entry => (sameEnvironment(entry, record.project, record.environment) && entry.run === record.run ? record : entry))
        return this.save()
    }

    // At boot: a run still marked running belonged to an agent that has since stopped, so it never
    // finished. Each is marked failed and handed back, so the caller can remove what it left staged.
    async markInterrupted(now: number): Promise<CopyRecord[]> {
        const interrupted: CopyRecord[] = []
        this.runs = this.runs.map(entry => {
            if (entry.outcome !== 'running') return entry
            const marked: CopyRecord = {
                ...entry, outcome: 'failed', reason: INTERRUPTED_REASON,
                durationMs: Math.max(0, now - Date.parse(entry.startedAt)),
            }
            interrupted.push(marked)
            return marked
        })
        if (interrupted.length > 0) await this.save()
        return interrupted
    }

    private save(): Promise<void> {
        const run = this.queue.then(() => this.write(this.runs), () => this.write(this.runs))
        this.queue = run
        return run
    }

    private async write(runs: CopyRecord[]): Promise<void> {
        const saved: Saved = { runs }
        // Same directory, so the rename is atomic, and a random suffix with 'wx' (O_CREAT | O_EXCL) so the
        // temporary name can neither be guessed and pre-planted nor opened through if it is.
        const temporary = posix.join(posix.dirname(this.path), `.${posix.basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`)
        try {
            await this.fs.mkdir(posix.dirname(this.path))
            await this.fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx' })
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            this.warn(`the copy history could not be written: ${describeError(error)}`)
        }
    }
}
