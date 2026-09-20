// The storage guard's current verdict for every project. A failing project is refused, never fatal, so
// one broken site cannot take the others offline.

import { lstat, stat } from 'node:fs/promises'
import type { ProjectEntry, Registry } from '../shared/registry.ts'
import { describeError } from '../shared/formats.ts'
import { resolveCompose, type Runner } from './compose.ts'
import { guardProblems, guardAdvisories } from './guard.ts'

export type DirCheck = (path: string) => Promise<boolean>

const isDirectoryOnDisk: DirCheck = async path => {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

// Phase 1 never dereferences a storage root, but the guard still must not pass one that is a symlink (or
// missing, or a plain file), because phase 3's file access inherits the assumption that it is trustworthy.
// lstat, not stat, so a symlink is reported as itself rather than as whatever it points to.
export type StorageRootState = 'ok' | 'missing' | 'not-a-directory'
export type StorageRootCheck = (path: string) => Promise<StorageRootState>

const storageRootOnDisk: StorageRootCheck = async path => {
    try {
        return (await lstat(path)).isDirectory() ? 'ok' : 'not-a-directory'
    } catch {
        return 'missing'
    }
}

export class GuardTracker {
    private readonly invalid = new Map<string, string>()
    // Kept apart from invalid on purpose: nothing here may ever reach checkStructure's guardInvalid gate,
    // since an advisory must never refuse a verb. See guardAdvisories's own comment for why that matters.
    private readonly advisories = new Map<string, string>()

    constructor(
        private readonly run: Runner,
        private readonly isDirectory: DirCheck = isDirectoryOnDisk,
        private readonly storageRoot: StorageRootCheck = storageRootOnDisk,
    ) {}

    current(): ReadonlyMap<string, string> {
        return this.invalid
    }

    async check(project: ProjectEntry): Promise<string | null> {
        // One project's guard failure must never take the others offline, so an unexpected shape (a
        // shallow-checked compose config, say) is a problem for this project, not an exception for the caller.
        let problem: string | null
        try {
            problem = await this.problemOf(project)
        } catch (error) {
            problem = `the storage guard could not check this project: ${describeError(error)}`
        }
        if (problem) this.invalid.set(project.id, problem)
        else this.invalid.delete(project.id)

        // Needs nothing this call resolved from compose or disk, only the registry entry itself, so it
        // runs regardless of whether the project above passed or failed.
        const advisories = guardAdvisories(project)
        if (advisories.length > 0) this.advisories.set(project.id, advisories.join('; '))
        else this.advisories.delete(project.id)

        return problem
    }

    async checkAll(registry: Registry): Promise<void> {
        for (const id of [...this.invalid.keys()]) {
            if (!registry.projects.has(id)) this.invalid.delete(id)
        }
        for (const id of [...this.advisories.keys()]) {
            if (!registry.projects.has(id)) this.advisories.delete(id)
        }
        for (const project of registry.projects.values()) await this.check(project)
    }

    // A project that is already invalid is usually invalid because its cause is being fixed right now, and a
    // verdict that lags behind the fix reads as "still broken". Re-checking just those is cheap, so it runs
    // far more often than the full sweep; a project that passes is left to the sweep and to the pre-start check.
    async recheckInvalid(registry: Registry): Promise<void> {
        for (const id of [...this.invalid.keys()]) {
            const project = registry.projects.get(id)
            if (project) await this.check(project)
            else this.invalid.delete(id)
        }
    }

    warnings(): string[] {
        return [
            ...[...this.invalid].map(([id, problem]) => `project ${id} is invalid: ${problem}`),
            ...this.advisories.values(),
        ]
    }

    private async problemOf(project: ProjectEntry): Promise<string | null> {
        if (!(await this.isDirectory(project.dir))) return `${project.dir} does not exist on the dedi`
        for (const [name, storage] of Object.entries(project.storage)) {
            const state = await this.storageRoot(storage.absolute)
            if (state === 'missing') return `storage ${name} (${storage.absolute}) does not exist`
            if (state === 'not-a-directory') return `storage ${name} (${storage.absolute}) is not a directory`
        }
        const resolved = await resolveCompose(project, this.run)
        if (!resolved.ok) return resolved.problem
        const problems = guardProblems(project, resolved.resolved)
        return problems.length > 0 ? problems.join('; ') : null
    }
}
