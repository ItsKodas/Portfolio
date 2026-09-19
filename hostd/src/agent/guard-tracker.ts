// The storage guard's current verdict for every project. A failing project is refused, never fatal, so
// one broken site cannot take the others offline.

import { stat } from 'node:fs/promises'
import type { ProjectEntry, Registry } from '../shared/registry.ts'
import { resolveCompose, type Runner } from './compose.ts'
import { guardProblems } from './guard.ts'

export type DirCheck = (path: string) => Promise<boolean>

const isDirectoryOnDisk: DirCheck = async path => {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

export class GuardTracker {
    private readonly invalid = new Map<string, string>()

    constructor(private readonly run: Runner, private readonly isDirectory: DirCheck = isDirectoryOnDisk) {}

    current(): ReadonlyMap<string, string> {
        return this.invalid
    }

    async check(project: ProjectEntry): Promise<string | null> {
        const problem = await this.problemOf(project)
        if (problem) this.invalid.set(project.id, problem)
        else this.invalid.delete(project.id)
        return problem
    }

    async checkAll(registry: Registry): Promise<void> {
        for (const id of [...this.invalid.keys()]) {
            if (!registry.projects.has(id)) this.invalid.delete(id)
        }
        for (const project of registry.projects.values()) await this.check(project)
    }

    warnings(): string[] {
        return [...this.invalid].map(([id, problem]) => `project ${id} is invalid: ${problem}`)
    }

    private async problemOf(project: ProjectEntry): Promise<string | null> {
        if (!(await this.isDirectory(project.dir))) return `${project.dir} does not exist on the dedi`
        const resolved = await resolveCompose(project, this.run)
        if (!resolved.ok) return resolved.problem
        const problems = guardProblems(project, resolved.resolved)
        return problems.length > 0 ? problems.join('; ') : null
    }
}
