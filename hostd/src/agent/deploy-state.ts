// The deploy history on disk: one JSON file for every environment, read once at boot and written
// atomically on every change. One file rather than one per environment because the whole thing is a few
// hundred records at most, and one atomic rename is easier to reason about than a directory of them.
//
// A write that fails never costs the caller its record: the deploy has already happened by the time this
// is called, exactly like the audit log's own rule, so the in-memory state is updated first and a failed
// write is a logged problem rather than a thrown one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

import { describeError } from '../shared/formats.ts'
import { emptyDeploys, recordDeploy, type DeployRecord, type EnvironmentDeploys } from '../shared/deploys.ts'

export type DeployStateFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(dir: string): Promise<void>
}

const nodeFs: DeployStateFs = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    rename: (from, to) => rename(from, to),
    mkdir: async dir => { await mkdir(dir, { recursive: true }) },
}

type Saved = { environments: Record<string, EnvironmentDeploys> }

export class DeployStore {
    private environments = new Map<string, EnvironmentDeploys>()
    private problem: string | null = null

    constructor(
        private readonly path: string,
        private readonly fs: DeployStateFs = nodeFs,
        private readonly log: (message: string) => void = () => {},
    ) {}

    // Never throws: a missing file is an environment that has never deployed, and an unreadable one is a
    // problem to warn about, not a reason to refuse to start. Starting empty can at worst cost an
    // environment its pause, which the next three failures re-earn.
    async load(): Promise<void> {
        let text: string
        try {
            text = await this.fs.readFile(this.path)
        } catch {
            return
        }
        try {
            const saved = JSON.parse(text) as Partial<Saved>
            if (!saved || typeof saved !== 'object' || !saved.environments) throw new Error('the file is not a deploy history')
            this.environments = new Map(Object.entries(saved.environments))
        } catch (error) {
            this.problem = `the deploy history at ${this.path} could not be read: ${describeError(error)}`
            this.log(`WARN ${this.problem}`)
        }
    }

    warnings(): string[] {
        return this.problem ? [this.problem] : []
    }

    get(key: string): EnvironmentDeploys {
        return this.environments.get(key) ?? emptyDeploys()
    }

    isPaused(key: string): boolean {
        return this.get(key).paused
    }

    async record(key: string, record: DeployRecord): Promise<void> {
        this.environments.set(key, recordDeploy(this.get(key), record))
        await this.save()
    }

    // What a manual deploy, a rollback or a branch switch does to a paused environment: the operator has
    // acted, so polling starts again and the failures that paused it are forgotten.
    async resume(key: string): Promise<void> {
        const state = this.get(key)
        if (!state.paused && state.consecutiveFailures === 0) return
        this.environments.set(key, { ...state, consecutiveFailures: 0, paused: false })
        await this.save()
    }

    private async save(): Promise<void> {
        const saved: Saved = { environments: Object.fromEntries(this.environments) }
        // Same directory, so the rename is atomic, and a random suffix with 'wx' (O_CREAT | O_EXCL) so
        // the temporary name can neither be guessed and pre-planted nor opened through if it is.
        const temporary = posix.join(posix.dirname(this.path), `.${posix.basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`)
        try {
            await this.fs.mkdir(posix.dirname(this.path))
            await this.fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx' })
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            this.log(`WARN the deploy history could not be written: ${describeError(error)}`)
        }
    }
}
