// The only code that writes the registry. Every change is applied to the document, parsed back with the
// same validator hostd uses at load, and only then written: a write can never produce a file hostd would
// refuse to load. Editing the parsed YAML document rather than re-serialising the Registry keeps the
// operator's comments and hand-written formatting intact.

import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { parseDocument, type Document } from 'yaml'

import { parseRegistry, RegistryError, type CertificateMode, type EnvironmentName } from './registry.ts'
import { describeError, RESERVED_PROJECT_IDS, PROJECT_ID } from './formats.ts'

export type RegistryWriteFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    unlink(path: string): Promise<void>
}

const nodeFs: RegistryWriteFs = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    rename: (from, to) => rename(from, to),
    unlink: path => unlink(path),
}

export type EnvironmentDraft = {
    name: EnvironmentName
    dir: string
    branch: string
    domain: string | null
    port: number
    certificate: CertificateMode | null
}

export type ProjectDraft = {
    client: string
    name: string
    repo: string
    services: Record<string, { role: 'site' } | { role: 'database', engine: string }>
    environment: EnvironmentDraft
}

export type Change =
    | { kind: 'add-project', id: string, project: ProjectDraft }
    | { kind: 'add-environment', id: string, environment: EnvironmentDraft }
    | { kind: 'set-deployed', id: string, environment: EnvironmentName, commit: string }
    | { kind: 'remove-project', id: string }
    | { kind: 'remove-environment', id: string, environment: EnvironmentName }

const environmentNode = (draft: EnvironmentDraft) => ({
    dir: draft.dir,
    branch: draft.branch,
    ...(draft.domain ? { domain: draft.domain } : {}),
    port: draft.port,
    ...(draft.certificate ? { certificate: draft.certificate } : {}),
})

// `conflict: true` marks the two cases where the id or environment turned out to already be taken, by
// something already in the document rather than by this change's own values. A caller that made a folder
// on disk before attempting the write can use that flag to tell "someone else already claimed this" (the
// folder may not even be theirs any more) apart from every other failure (which is safe to roll back),
// without depending on the exact wording of the message staying the same.
type EditResult = { problem: string, conflict?: true } | null

function edit(doc: Document, change: Change): EditResult {
    const projects = doc.getIn(['projects'])
    if (!projects) return { problem: 'the registry has no projects section' }
    const has = (id: string) => doc.hasIn(['projects', id])

    switch (change.kind) {
        case 'add-project':
            if (!PROJECT_ID.test(change.id)) return { problem: `${change.id} is not a valid project id` }
            if (RESERVED_PROJECT_IDS.has(change.id)) return { problem: `${change.id} is reserved` }
            if (has(change.id)) return { problem: `${change.id} already exists`, conflict: true }
            doc.setIn(['projects', change.id], {
                client: change.project.client,
                name: change.project.name,
                repo: change.project.repo,
                services: change.project.services,
                environments: { [change.project.environment.name]: environmentNode(change.project.environment) },
            })
            return null
        case 'add-environment':
            if (!has(change.id)) return { problem: `${change.id} is not registered` }
            if (doc.hasIn(['projects', change.id, 'environments', change.environment.name])) {
                return { problem: `${change.id} already has a ${change.environment.name} environment`, conflict: true }
            }
            doc.setIn(['projects', change.id, 'environments', change.environment.name], environmentNode(change.environment))
            return null
        case 'set-deployed':
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return { problem: `${change.id} has no ${change.environment} environment` }
            }
            doc.setIn(['projects', change.id, 'environments', change.environment, 'deployed'], change.commit)
            return null
        case 'remove-project':
            if (!has(change.id)) return { problem: `${change.id} is not registered` }
            doc.deleteIn(['projects', change.id])
            return null
        case 'remove-environment':
            if (change.environment === 'live') return { problem: 'the live environment cannot be removed on its own' }
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return { problem: `${change.id} has no ${change.environment} environment` }
            }
            doc.deleteIn(['projects', change.id, 'environments', change.environment])
            return null
    }
}

export type WriteResult = { ok: true, text: string } | { ok: false, problem: string, conflict?: true }

export function applyChange(text: string, change: Change): WriteResult {
    let doc: Document
    try {
        doc = parseDocument(text)
        const firstError = doc.errors[0]
        if (firstError) return { ok: false, problem: firstError.message }
    } catch (error) {
        return { ok: false, problem: describeError(error) }
    }

    const edited = edit(doc, change)
    if (edited) return { ok: false, problem: edited.problem, ...(edited.conflict ? { conflict: edited.conflict } : {}) }

    const next = doc.toString()
    // The same validator that runs at load, so a write can never produce a file hostd would refuse
    let registry
    try {
        registry = parseRegistry(next)
    } catch (error) {
        return { ok: false, problem: error instanceof RegistryError ? error.failures.join('; ') : describeError(error) }
    }
    const id = change.id
    const invalid = registry.invalid.get(id)
    if (invalid) return { ok: false, problem: invalid }
    if (change.kind !== 'remove-project' && !registry.projects.has(id)) return { ok: false, problem: `${id} did not survive the change` }
    return { ok: true, text: next }
}

export class RegistryWriter {
    // One write at a time: two callers adding a project must not both read the same text and lose one.
    private queue: Promise<unknown> = Promise.resolve()

    constructor(private readonly path: string, private readonly fs: RegistryWriteFs = nodeFs) {}

    async write(change: Change): Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }> {
        const run = this.queue.then(() => this.writeNow(change), () => this.writeNow(change))
        this.queue = run.catch(() => {})
        return run
    }

    private async writeNow(change: Change): Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }> {
        let text: string
        try {
            text = await this.fs.readFile(this.path)
        } catch (error) {
            return { ok: false, problem: `the registry could not be read: ${describeError(error)}` }
        }
        const applied = applyChange(text, change)
        if (!applied.ok) return applied

        // Same directory, so the rename is atomic: a crash leaves either the old file or the new one.
        const temporary = this.path.replace(/([^/]+)$/, '.$1.tmp')
        try {
            await this.fs.writeFile(temporary, applied.text)
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            await this.fs.unlink(temporary).catch(() => {})
            return { ok: false, problem: `the registry could not be written: ${describeError(error)}` }
        }
        return { ok: true }
    }
}
