// Backup schedules on disk: one JSON file holding all project schedules, read once at startup and
// written atomically on every change, exactly like backup-state.ts. Schedules are client-set
// configuration, not operator configuration, so they live in api's /state, not in the registry.
//
// A write that fails never costs the caller its record: the schedule has already been updated in
// memory before this is called, so a failed write is a logged problem, not a thrown one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

import { defaultSchedule, isDue, type Schedule } from '../shared/backups.ts'
import { describeError } from '../shared/formats.ts'
import type { Registry } from '../shared/registry.ts'

export type ScheduleFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(dir: string): Promise<void>
}

const nodeFs: ScheduleFs = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    rename: (from, to) => rename(from, to),
    mkdir: async dir => { await mkdir(dir, { recursive: true }) },
}

type Saved = { schedules: Record<string, Schedule> }

export class ScheduleStore {
    private schedules = new Map<string, Schedule>()
    private problem: string | null = null

    constructor(
        private readonly path: string,
        private readonly fs: ScheduleFs = nodeFs,
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
            if (!saved || typeof saved !== 'object' || !saved.schedules) throw new Error('the file is not a schedule store')
            this.schedules = new Map(Object.entries(saved.schedules))
        } catch (error) {
            this.problem = `the schedule store at ${this.path} could not be read: ${describeError(error)}`
            this.log(`WARN ${this.problem}`)
        }
    }

    warnings(): string[] {
        return this.problem ? [this.problem] : []
    }

    get(id: string): Schedule {
        return this.schedules.get(id) ?? defaultSchedule()
    }

    async set(id: string, schedule: Schedule): Promise<void> {
        this.schedules.set(id, schedule)
        await this.save()
    }

    // Which projects should have a scheduled run started now. The registry is consulted every tick
    // rather than cached, so a capability the operator switches off stops the schedule immediately,
    // and a project removed from the registry stops being named without its schedule having to be
    // cleaned up.
    due(registry: Registry, lastRunAt: (id: string) => number | null, now: number): Array<{ id: string, schedule: Schedule }> {
        const due: Array<{ id: string, schedule: Schedule }> = []
        for (const [id, schedule] of this.schedules) {
            const project = registry.projects.get(id)
            if (!project || !project.capabilities.has('backups')) continue
            if (isDue(schedule, lastRunAt(id), now)) due.push({ id, schedule })
        }
        return due
    }

    private async save(): Promise<void> {
        const saved: Saved = { schedules: Object.fromEntries(this.schedules) }
        // Same directory, so the rename is atomic, and a random suffix with 'wx' (O_CREAT | O_EXCL) so the
        // temporary name can neither be guessed and pre-planted nor opened through if it is.
        const temporary = posix.join(posix.dirname(this.path), `.${posix.basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`)
        try {
            await this.fs.mkdir(posix.dirname(this.path))
            await this.fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx' })
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            this.log(`WARN the schedule store could not be written: ${describeError(error)}`)
        }
    }
}
