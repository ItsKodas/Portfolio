// The only code that writes the registry. Every change is applied to the document, parsed back with the
// same validator hostd uses at load, and only then written: a write can never produce a file hostd would
// refuse to load. Editing the parsed YAML document rather than re-serialising the Registry keeps the
// operator's comments and hand-written formatting intact.

import { readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { parseDocument, isMap, isScalar, type Document } from 'yaml'

import { parseRegistry, RegistryError, type Capability, type CertificateMode, type EnvironmentName } from './registry.ts'
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
    // One kind rather than three, because a write takes one Change: three would be three reads, three
    // validations, three files on disk and a half-applied save if the second failed. Absent fields are
    // left alone; a null repo or branch deletes that key.
    | {
        kind: 'configure'
        id: string
        capabilities?: Capability[]
        repo?: string | null
        branches?: Partial<Record<EnvironmentName, string | null>>
    }
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

// A project written the live-only way keeps dir, compose and upstream at the top level and has no
// environments node at all, so there is nothing for a branch to be set on: set-branch answers
// "<id> has no live environment" and always did. This reshapes the entry into the one live environment
// parseRegistry already synthesises for it, which is the same site described the other way round.
//
// upstream's host is not carried anywhere. There is no per-environment host field, and parseRegistry
// answers 127.0.0.1 for an environments-shaped entry, so an entry whose upstream host was something else
// is changed by this rather than merely reshaped. Every real entry uses the loopback address.
function toEnvironments(doc: Document, id: string): EditResult {
    const dir = doc.getIn(['projects', id, 'dir'])
    if (typeof dir !== 'string') return { problem: `${id} has no dir to make an environment from` }

    const upstream = doc.getIn(['projects', id, 'upstream'])
    if (typeof upstream !== 'string') return { problem: `${id} has no upstream to take a port from` }
    // Only the number is read here. Whether it is a usable port is parseRegistry's to say, below.
    const port = Number(upstream.slice(upstream.lastIndexOf(':') + 1))

    const live: Record<string, unknown> = { dir }
    // compose is one file or several, and both spellings are carried across as they were written
    const compose = doc.getIn(['projects', id, 'compose'])
    if (compose !== undefined && compose !== null) {
        live.compose = typeof compose === 'object' && 'toJSON' in compose
            ? (compose as { toJSON: () => unknown }).toJSON()
            : compose
    }
    live.port = port

    // A hand-written note above dir, compose or upstream lives on that key's own node as commentBefore;
    // deleteIn below would throw it away with the key. Carry whichever of the three the operator actually
    // commented (there is normally at most one) onto the environments key that replaces all three.
    const projectNode = doc.getIn(['projects', id], true)
    let comment: string | null | undefined
    if (isMap(projectNode)) {
        for (const pair of projectNode.items) {
            if (isScalar(pair.key) && (pair.key.value === 'dir' || pair.key.value === 'compose' || pair.key.value === 'upstream') && pair.key.commentBefore) {
                comment = pair.key.commentBefore
                break
            }
        }
    }

    // setIn does not deep-convert a plain nested object into YAML nodes: getIn(['environments']) would
    // come back as a bare JS object, and hasIn(['environments', 'live']) would then answer false, because
    // there is no YAMLMap there to walk into. createNode does the deep conversion; setIn does not need to.
    doc.setIn(['projects', id, 'environments'], doc.createNode({ live }))
    doc.deleteIn(['projects', id, 'dir'])
    doc.deleteIn(['projects', id, 'compose'])
    doc.deleteIn(['projects', id, 'upstream'])

    if (comment) {
        const updated = doc.getIn(['projects', id], true)
        // setIn adding a brand new key stores it as a bare JS string, not a Scalar node, until stringify
        // time, so there is nowhere on it yet to hang a comment: build the node ourselves to get one.
        const environmentsPair = isMap(updated)
            ? updated.items.find(pair => (isScalar(pair.key) ? pair.key.value : pair.key) === 'environments')
            : undefined
        if (environmentsPair) {
            const key = doc.createNode('environments')
            key.commentBefore = comment
            environmentsPair.key = key
        }
    }
    return null
}

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
        case 'configure': {
            if (!has(change.id)) return { problem: `${change.id} is not registered` }

            const branches = Object.entries(change.branches ?? {})
            // A branch has nowhere to go on an entry written the live-only way, so the shape comes first
            if (branches.length > 0 && !doc.hasIn(['projects', change.id, 'environments'])) {
                const converted = toEnvironments(doc, change.id)
                if (converted) return converted
            }

            // Flow style, because that is how the file writes it by hand and a write should not
            // reformat a file a person maintains.
            if (change.capabilities) {
                const node = doc.createNode(change.capabilities)
                node.flow = true
                doc.setIn(['projects', change.id, 'capabilities'], node)
            }

            if (change.repo !== undefined) {
                if (change.repo === null) doc.deleteIn(['projects', change.id, 'repo'])
                else doc.setIn(['projects', change.id, 'repo'], change.repo)
            }

            for (const [name, branch] of branches) {
                const path = ['projects', change.id, 'environments', name]
                if (!doc.hasIn(path)) return { problem: `${change.id} has no ${name} environment` }
                if (branch === null) doc.deleteIn([...path, 'branch'])
                else doc.setIn([...path, 'branch'], branch)
            }

            // No grammar checked here on purpose: applyChange re-parses the whole document with
            // parseRegistry below, which is the one place that decides what a capability, a repo and a
            // branch may be. Two copies of that rule would drift.
            return null
        }
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

    // yaml's default stringify options pad every flow collection ("[ a, b ]", "{ a: b }") whether or not
    // its source had that padding, which would reformat the operator's own "[lifecycle, logs]" style on
    // any write, not just one that touched it. There is no per-node override, only this whole-document
    // one, so unpadded is the document-wide default: it matches how every flow sequence in the real
    // registry is hand-written, at the cost of also flattening the padding on flow mappings like
    // "{ role: site }", which the file does write padded. See registry-write.test.ts's flow-style case.
    const next = doc.toString({ flowCollectionPadding: false })
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
