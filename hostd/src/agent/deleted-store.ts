// The record of deleted environments: one JSON file in the agent's state directory, one entry per
// environment sitting in a site's trash folder. It lives outside projects.yaml on purpose: a deleted
// environment never counts in the registry's port, hostname, dir or compose name checks, and the
// operator's own edits of the registry never see it.
//
// Unlike the deploy history, a write that fails is thrown to the caller rather than logged: a delete that
// went ahead without its record would leave a trash folder nothing can restore or purge, so the delete
// undoes itself instead. The in-memory list only changes once the file on disk has.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

import { describeError, isRecord } from '../shared/formats.ts'

// How long a deleted environment stays restorable before the sweep purges it with its volumes.
export const DELETED_KEEP_MS = 30 * 24 * 60 * 60_000

export type DeletedRecord = {
    project: string
    environment: string
    // ISO, and also what names one record when the same environment was deleted more than once
    deletedAt: string
    // Absolute: <site>/.deleted/<env>-<unix seconds>, holding tree, and prev and next when they existed
    trash: string
    // The compose project the environment ran under, which is what its volumes are labelled with
    composeName: string
    // The registry node exactly as it was, as plain data, so a restore can write it back
    node: Record<string, unknown>
    actor: string
}

export type DeletedStoreFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(dir: string): Promise<void>
}

const nodeFs: DeletedStoreFs = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    rename: (from, to) => rename(from, to),
    mkdir: async dir => { await mkdir(dir, { recursive: true }) },
}

type Saved = { environments: DeletedRecord[] }

function isDeletedRecord(value: unknown): value is DeletedRecord {
    return isRecord(value)
        && typeof value.project === 'string' && typeof value.environment === 'string'
        && typeof value.deletedAt === 'string' && Number.isFinite(Date.parse(value.deletedAt))
        && typeof value.trash === 'string' && typeof value.composeName === 'string'
        && isRecord(value.node) && typeof value.actor === 'string'
}

const sameRecord = (entry: DeletedRecord, project: string, environment: string, deletedAt: string): boolean =>
    entry.project === project && entry.environment === environment && entry.deletedAt === deletedAt

export class DeletedStore {
    private records: DeletedRecord[] = []
    private problem: string | null = null
    // Set when the file was there but could not be understood: writing over it would forget every trash
    // folder it named, so every write refuses until the operator has looked.
    private unreadable = false
    // One write at a time, so a purge and a delete finishing together cannot lose one another's change.
    private queue: Promise<unknown> = Promise.resolve()

    constructor(
        private readonly path: string,
        private readonly fs: DeletedStoreFs = nodeFs,
        private readonly log: (message: string) => void = () => {},
    ) {}

    // Never throws: a missing file is a machine that has never deleted an environment.
    async load(): Promise<void> {
        let text: string
        try {
            text = await this.fs.readFile(this.path)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
            this.fail(`the deleted environments record at ${this.path} could not be read: ${describeError(error)}`)
            return
        }
        try {
            const saved = JSON.parse(text) as Partial<Saved>
            if (!isRecord(saved) || !Array.isArray(saved.environments)) throw new Error('the file is not a deleted environments record')
            const valid = saved.environments.filter(isDeletedRecord)
            this.records = valid
            const dropped = saved.environments.length - valid.length
            if (dropped > 0) {
                this.problem = `the deleted environments record at ${this.path} had ${dropped} malformed entries, which were ignored`
                this.log(`WARN ${this.problem}`)
            }
        } catch (error) {
            this.fail(`the deleted environments record at ${this.path} could not be read: ${describeError(error)}`)
        }
    }

    private fail(problem: string): void {
        this.problem = problem
        this.unreadable = true
        this.log(`WARN ${problem}`)
    }

    warnings(): string[] {
        return this.problem ? [this.problem] : []
    }

    list(project?: string): DeletedRecord[] {
        return this.records.filter(entry => project === undefined || entry.project === project)
    }

    // Whether this name was deleted from this project less than 30 days ago, so a new environment may not
    // take it while the old one can still be restored.
    deletedWithin(project: string, environment: string, now: number): boolean {
        return this.records.some(entry => entry.project === project && entry.environment === environment
            && now - Date.parse(entry.deletedAt) < DELETED_KEEP_MS)
    }

    add(record: DeletedRecord): Promise<void> {
        return this.change(records => [...records, record])
    }

    remove(project: string, environment: string, deletedAt: string): Promise<void> {
        return this.change(records => records.filter(entry => !sameRecord(entry, project, environment, deletedAt)))
    }

    private change(next: (records: DeletedRecord[]) => DeletedRecord[]): Promise<void> {
        const run = this.queue.then(() => this.save(next(this.records)), () => this.save(next(this.records)))
        this.queue = run.catch(() => {})
        return run
    }

    private async save(records: DeletedRecord[]): Promise<void> {
        if (this.unreadable) throw new Error(`${this.path} could not be read, so it is not written over; fix or move it first`)
        const saved: Saved = { environments: records }
        // Same directory, so the rename is atomic, and a random suffix with 'wx' (O_CREAT | O_EXCL) so the
        // temporary name can neither be guessed and pre-planted nor opened through if it is.
        const temporary = posix.join(posix.dirname(this.path), `.${posix.basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`)
        await this.fs.mkdir(posix.dirname(this.path))
        await this.fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx' })
        await this.fs.rename(temporary, this.path)
        this.records = records
    }
}
