// The only code that writes the registry. Every change is applied to the document, parsed back with the
// same validator hostd uses at load, and only then written: a write can never produce a file hostd would
// refuse to load. Editing the parsed YAML document rather than re-serialising the Registry keeps the
// operator's comments and hand-written formatting intact.

import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { parseDocument, type Document } from 'yaml'

import { parseRegistry, RegistryError, type CertificateMode, type EnvironmentName } from './registry.ts'
import { describeError, RESERVED_PROJECT_IDS, PROJECT_ID } from './formats.ts'

export type RegistryWriteFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    rename(from: string, to: string): Promise<void>
    unlink(path: string): Promise<void>
}

const nodeFs: RegistryWriteFs = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    rename: (from, to) => rename(from, to),
    unlink: path => unlink(path),
}

export type EnvironmentDraft = {
    name: EnvironmentName
    dir: string
    branch: string
    domain: string | null
    aliases: string[]
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
    | { kind: 'set-branch', id: string, environment: EnvironmentName, branch: string }
    // The whole list, not one alias at a time. A read-modify-write of a list through two verbs would
    // race with the operator's own editor; handing over the list that should be there makes the write
    // idempotent and lets the existing conflict check do its job.
    | { kind: 'set-aliases', id: string, environment: EnvironmentName, aliases: string[] }
    | { kind: 'remove-project', id: string }
    | { kind: 'remove-environment', id: string, environment: EnvironmentName }

const environmentNode = (draft: EnvironmentDraft) => ({
    dir: draft.dir,
    branch: draft.branch,
    ...(draft.domain ? { domain: draft.domain } : {}),
    ...(draft.aliases.length ? { aliases: draft.aliases } : {}),
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
        case 'set-branch':
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return { problem: `${change.id} has no ${change.environment} environment` }
            }
            // No grammar check here on purpose: applyChange re-parses the whole document with
            // parseRegistry below, which refuses a branch name that is not a plain one, so there is one
            // rule about what a branch may be rather than two that could drift.
            doc.setIn(['projects', change.id, 'environments', change.environment, 'branch'], change.branch)
            return null
        case 'set-aliases':
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return { problem: `${change.id} has no ${change.environment} environment` }
            }
            // An empty list removes the key entirely, so the last alias going away leaves no empty
            // aliases: [] behind, the same way domain and certificate are only ever present when set.
            if (change.aliases.length === 0) doc.deleteIn(['projects', change.id, 'environments', change.environment, 'aliases'])
            else doc.setIn(['projects', change.id, 'environments', change.environment, 'aliases'], change.aliases)
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

        // Same directory, so the rename is atomic: a crash leaves either the old file or the new one. A
        // random suffix, so the name cannot be guessed and pre-planted as a symlink by anything else that
        // can write into this directory, and 'wx' (O_CREAT | O_EXCL), which fails on anything already at
        // that path, symlink or not, rather than opening through it. Same defense as env-files.ts's own
        // temp file.
        const temporary = this.path.replace(/([^/]+)$/, `.$1.${randomBytes(6).toString('hex')}.tmp`)
        try {
            await this.fs.writeFile(temporary, applied.text, { flag: 'wx' })
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            await this.fs.unlink(temporary).catch(() => {})
            return { ok: false, problem: `the registry could not be written: ${describeError(error)}` }
        }
        return { ok: true }
    }
}
