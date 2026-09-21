// The backup run history on disk: one JSON file for every project, read once at boot and written
// atomically on every change, exactly like deploy-state.ts. Restic holds the snapshots themselves; this
// holds what happened, including the runs that produced no snapshot at all.
//
// A write that fails never costs the caller its record: the run has already happened by the time this is
// called, so the in-memory state is updated first and a failed write is a logged problem, not a thrown one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

import { describeError } from '../shared/formats.ts'
import { emptyBackups, lastScheduledFailure, recordBackup, type BackupRecord, type ProjectBackups } from '../shared/backups.ts'

export type BackupStateFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(dir: string): Promise<void>
}

const nodeFs: BackupStateFs = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    rename: (from, to) => rename(from, to),
    mkdir: async dir => { await mkdir(dir, { recursive: true }) },
}

type Saved = { projects: Record<string, ProjectBackups> }

export class BackupStore {
    private projects = new Map<string, ProjectBackups>()
    private problem: string | null = null

    constructor(
        private readonly path: string,
        private readonly fs: BackupStateFs = nodeFs,
        private readonly log: (message: string) => void = () => {},
    ) {}

    async load(): Promise<void> {
        let text: string
        try {
            text = await this.fs.readFile(this.path)
        } catch {
            return
        }
        try {
            const saved = JSON.parse(text) as Partial<Saved>
            if (!saved || typeof saved !== 'object' || !saved.projects) throw new Error('the file is not a backup history')
            this.projects = new Map(Object.entries(saved.projects))
        } catch (error) {
            this.problem = `the backup history at ${this.path} could not be read: ${describeError(error)}`
            this.log(`WARN ${this.problem}`)
        }
    }

    warnings(): string[] {
        return this.problem ? [this.problem] : []
    }

    get(id: string): ProjectBackups {
        return this.projects.get(id) ?? emptyBackups()
    }

    // When this project last had a run of any kind start. The schedule is measured against this, so a
    // manual run also pushes the next scheduled one out, which is what the client would expect.
    lastRunAt(id: string): number | null {
        const newest = this.get(id).runs[0]
        if (!newest) return null
        const at = Date.parse(newest.startedAt)
        return Number.isFinite(at) ? at : null
    }

    // The operator's health signal, one line per project whose newest scheduled run failed.
    failures(): string[] {
        const lines: string[] = []
        for (const [id, state] of this.projects) {
            const failed = lastScheduledFailure(state)
            if (failed) lines.push(`${id}: the newest scheduled backup failed: ${failed.reason ?? 'no reason recorded'}`)
        }
        return lines
    }

    async record(id: string, record: BackupRecord): Promise<void> {
        this.projects.set(id, recordBackup(this.get(id), record))
        await this.save()
    }

    private async save(): Promise<void> {
        const saved: Saved = { projects: Object.fromEntries(this.projects) }
        // Same directory, so the rename is atomic, and a random suffix with 'wx' (O_CREAT | O_EXCL) so the
        // temporary name can neither be guessed and pre-planted nor opened through if it is.
        const temporary = posix.join(posix.dirname(this.path), `.${posix.basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`)
        try {
            await this.fs.mkdir(posix.dirname(this.path))
            await this.fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx' })
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            this.log(`WARN the backup history could not be written: ${describeError(error)}`)
        }
    }
}
