// Starts a backup and answers immediately. A backup is minutes of dumping and uploading; api's own call
// timeout is 150 seconds, so a verb that waited for one would always time out. The reply says the run
// started, and the run history is where the outcome shows up.
//
// Two locks, both from the design: one backup per project, and one backup across the whole dedi, so a
// scheduled sweep can never saturate the disk. Both are taken before any await, so two requests arriving
// together cannot both see a free slot.
//
// And one refusal that is not a lock: a deploy in flight for this project. A deploy renames the directory
// the storage lives under, so a backup started mid-swap would walk a tree that is moving. The reverse is
// deliberately not enforced (see the design): by the time a deploy could start mid-backup, the dumps are
// already in staging, so the one thing that cannot be re-read is never torn.

import { describeError } from '../shared/formats.ts'
import type { BackupRecord, BackupTag } from '../shared/backups.ts'
import { refuse, type Refusal } from '../shared/protocol.ts'
import type { ProjectEntry } from '../shared/registry.ts'
import { runBackup, type BackupDeps, type BackupRequest } from './backup-run.ts'
import type { BackupStore } from './backup-state.ts'

export type BackupRunnerDeps = BackupDeps & { store: BackupStore, deployRunning: (id: string) => boolean }
export type BackupStartedReply = { ok: true, started: { run: string, tag: BackupTag } }
type Backup = (project: ProjectEntry, request: BackupRequest, deps: BackupDeps) => Promise<BackupRecord>

export class BackupRunner {
    private readonly running = new Map<string, Promise<void>>()

    // `backup` is injected only so the tests can hold a run open and watch the locking; everything else
    // passes the real one.
    constructor(private readonly deps: BackupRunnerDeps, private readonly backup: Backup = runBackup) {}

    isRunning(id: string): boolean {
        return this.running.has(id)
    }

    isBusy(): boolean {
        return this.running.size > 0
    }

    start(project: ProjectEntry, request: BackupRequest): BackupStartedReply | Refusal {
        if (this.running.has(project.id)) return refuse('busy', `${project.id} already has a backup running`)
        if (this.running.size > 0) return refuse('busy', 'another backup is running; only one runs on the dedi at a time')
        if (this.deps.deployRunning(project.id)) return refuse('busy', `${project.id} is deploying; a backup waits until that has finished`)

        this.running.set(project.id, this.run(project, request))
        return { ok: true, started: { run: request.run, tag: request.tag } }
    }

    // For the tests, and for a clean shutdown: nothing in production awaits a run.
    async settle(): Promise<void> {
        await Promise.all([...this.running.values()])
    }

    private async run(project: ProjectEntry, request: BackupRequest): Promise<void> {
        try {
            let record: BackupRecord
            try {
                record = await this.backup(project, request, this.deps)
            } catch (error) {
                // runBackup returns its failures rather than throwing, so this is the unforeseen kind. It
                // still has to be recorded, or a run that crashed would look like one that never happened.
                record = {
                    run: request.run, tag: request.tag, actor: request.actor,
                    startedAt: new Date(this.deps.now()).toISOString(), durationMs: 0,
                    outcome: 'failed', snapshot: null, reason: describeError(error), disruptive: false,
                }
            }
            await this.deps.store.record(project.id, record)
            if (record.outcome === 'failed') this.deps.log(`backup ${project.id} failed: ${record.reason}`)
        } finally {
            this.running.delete(project.id)
        }
    }
}
