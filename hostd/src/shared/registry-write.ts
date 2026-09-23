// The only code that writes the registry. Every change is applied to the document, parsed back with the
// same validator hostd uses at load, and only then written: a write can never produce a file hostd would
// refuse to load. Editing the parsed YAML document rather than re-serialising the Registry keeps the
// operator's comments and hand-written formatting intact.

import { readFile, writeFile, rename, unlink, stat, chmod, chown } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { parseDocument, isMap, isNode, isScalar, isSeq, type Document } from 'yaml'

import { parseRegistry, RegistryError, type Capability, type CertificateMode, type EnvironmentFlag, type EnvironmentName } from './registry.ts'
import { describeError, RESERVED_PROJECT_IDS, PROJECT_ID } from './formats.ts'

export type RegistryWriteFs = {
    readFile(path: string): Promise<string>
    stat(path: string): Promise<{ mode: number, uid: number, gid: number }>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    chmod(path: string, mode: number): Promise<void>
    chown(path: string, uid: number, gid: number): Promise<void>
    rename(from: string, to: string): Promise<void>
    unlink(path: string): Promise<void>
}

const nodeFs: RegistryWriteFs = {
    readFile: path => readFile(path, 'utf8'),
    stat: async path => {
        const info = await stat(path)
        return { mode: info.mode, uid: info.uid, gid: info.gid }
    },
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    chmod: (path, mode) => chmod(path, mode),
    chown: (path, uid, gid) => chown(path, uid, gid),
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
    // Relative to dir. Absent, or the default docker-compose.yml alone, writes no compose key at all,
    // exactly as a hand-written entry leaves it out.
    compose?: string[]
    // Written only when on, like domain and certificate, so an ordinary entry stays as short as before
    websockets?: boolean
    flexibleSsl?: boolean
}

export type ProjectDraft = {
    // null writes no client key: the operator's own site, which no client may see
    client: string | null
    name: string
    repo: string
    credential?: string | null
    capabilities?: Capability[]
    services: Record<string, { role: 'site' } | { role: 'database', engine: string }>
    environment: EnvironmentDraft
}

export type Change =
    | { kind: 'add-project', id: string, project: ProjectDraft }
    | { kind: 'add-environment', id: string, environment: EnvironmentDraft }
    | { kind: 'set-deployed', id: string, environment: EnvironmentName, commit: string }
    | { kind: 'set-branch', id: string, environment: EnvironmentName, branch: string }
    // Setting an address, never changing one: the caller (agent.ts's configure) refuses an environment
    // that already has a domain before it ever gets here. This writes the key either way, because what
    // may be set and when is a policy question and the writer only answers "would hostd load this".
    | { kind: 'set-domain', id: string, environment: EnvironmentName, domain: string }
    // The whole list, not one alias at a time. A read-modify-write of a list through two verbs would
    // race with the operator's own editor; handing over the list that should be there makes the write
    // idempotent and lets the existing conflict check do its job.
    | { kind: 'set-aliases', id: string, environment: EnvironmentName, aliases: string[] }
    | { kind: 'set-flag', id: string, environment: EnvironmentName, flag: EnvironmentFlag, enabled: boolean }
    // Written once per environment, by the deploy that moves it into the nested layout. Both keys at
    // once: the dir changes the folder compose would derive a name from, so the name it had is pinned
    // in the same write.
    | { kind: 'set-layout', id: string, environment: EnvironmentName, dir: string, composeName: string }
    // One kind rather than three, because a write takes one Change: three would be three reads, three
    // validations, three files on disk and a half-applied save if the second failed. Absent fields are
    // left alone; a null repo or branch deletes that key.
    | {
        kind: 'configure'
        id: string
        capabilities?: Capability[]
        repo?: string | null
        credential?: string | null
        branches?: Partial<Record<EnvironmentName, string | null>>
    }
    | { kind: 'remove-project', id: string }
    | { kind: 'remove-environment', id: string, environment: EnvironmentName }

const environmentNode = (draft: EnvironmentDraft) => ({
    dir: draft.dir,
    branch: draft.branch,
    ...(draft.domain ? { domain: draft.domain } : {}),
    ...(draft.aliases.length ? { aliases: draft.aliases } : {}),
    ...(draft.compose && !(draft.compose.length === 1 && draft.compose[0] === 'docker-compose.yml') ? { compose: draft.compose } : {}),
    port: draft.port,
    ...(draft.certificate ? { certificate: draft.certificate } : {}),
    ...(draft.websockets ? { websockets: true } : {}),
    ...(draft.flexibleSsl ? { flexibleSsl: true } : {}),
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
    // Whether the operator wrote the list on one line. toJSON below unwraps the node to a plain array, and
    // createNode then gives the new one the library's default block style, so the flag is read here and
    // put back on the new node below. A write that was asked for a branch has no business reformatting
    // the list beside it, any more than the capabilities case has (see the flow: true there).
    const composeWasFlow = isSeq(compose) && compose.flow === true
    if (compose !== undefined && compose !== null) {
        live.compose = typeof compose === 'object' && 'toJSON' in compose
            ? (compose as { toJSON: () => unknown }).toJSON()
            : compose
    }
    live.port = port

    // A hand-written note about dir, compose or upstream lives in one of two places: on the key's own node
    // as commentBefore when it sits on a line above, and on the value's node as comment when it trails the
    // value on the same line. deleteIn below throws away the whole pair, so both go with it. Every note on
    // any of the three is carried onto the environments key that replaces all three, in the order the file
    // has them. A trailing note becomes a line of its own above environments: that is a move, and it is
    // the one thing yaml can express here. Losing it is not.
    const projectNode = doc.getIn(['projects', id], true)
    const notes: string[] = []
    if (isMap(projectNode)) {
        for (const pair of projectNode.items) {
            const key = isScalar(pair.key) ? pair.key.value : pair.key
            if (key !== 'dir' && key !== 'compose' && key !== 'upstream') continue
            if (isScalar(pair.key) && pair.key.commentBefore) notes.push(pair.key.commentBefore)
            if (isNode(pair.value) && pair.value.comment) notes.push(pair.value.comment)
        }
    }
    const comment = notes.join('\n')

    // setIn does not deep-convert a plain nested object into YAML nodes: getIn(['environments']) would
    // come back as a bare JS object, and hasIn(['environments', 'live']) would then answer false, because
    // there is no YAMLMap there to walk into. createNode does the deep conversion; setIn does not need to.
    const environments = doc.createNode({ live })
    if (composeWasFlow && isMap(environments)) {
        const written = environments.getIn(['live', 'compose'], true)
        if (isSeq(written)) written.flow = true
    }
    doc.setIn(['projects', id, 'environments'], environments)
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

function flowList(doc: Document, items: string[]) {
    const node = doc.createNode(items)
    node.flow = true
    return node
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
                ...(change.project.client !== null ? { client: change.project.client } : {}),
                name: change.project.name,
                repo: change.project.repo,
                ...(change.project.credential ? { credential: change.project.credential } : {}),
                // Flow style, as the configure case below writes it and as the file has it by hand
                ...(change.project.capabilities?.length ? { capabilities: flowList(doc, change.project.capabilities) } : {}),
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
        case 'set-layout':
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return { problem: `${change.id} has no ${change.environment} environment` }
            }
            // No grammar check here, as set-branch: parseRegistry below is the one rule for both keys.
            doc.setIn(['projects', change.id, 'environments', change.environment, 'dir'], change.dir)
            doc.setIn(['projects', change.id, 'environments', change.environment, 'composeName'], change.composeName)
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
        case 'set-domain':
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return { problem: `${change.id} has no ${change.environment} environment` }
            }
            // No grammar check here on purpose, exactly as set-branch above: applyChange re-parses the
            // whole document with parseRegistry below, which refuses a hostname that is not one and
            // refuses one already claimed elsewhere, so there is one rule about what a domain may be
            // rather than two that could drift.
            doc.setIn(['projects', change.id, 'environments', change.environment, 'domain'], change.domain)
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
        case 'set-flag':
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return { problem: `${change.id} has no ${change.environment} environment` }
            }
            // Off is the default, so switching it off removes the key rather than writing false, the same
            // way the last alias going away leaves no empty list behind.
            if (change.enabled) doc.setIn(['projects', change.id, 'environments', change.environment, change.flag], true)
            else doc.deleteIn(['projects', change.id, 'environments', change.environment, change.flag])
            return null
        case 'configure': {
            if (!has(change.id)) return { problem: `${change.id} is not registered` }

            const requested = Object.entries(change.branches ?? {})
            const shaped = doc.hasIn(['projects', change.id, 'environments'])
            // Only a branch actually being set is worth reshaping an entry for. The portal's form sends one
            // entry per environment on every save and a blank branch field arrives as null, so an ordinary
            // capability save on a live-only site carries branches: { live: null } with it. Clearing a
            // branch an entry has no room for is a no-op, not a reason to rewrite the operator's file: the
            // conversion is lossy on purpose (upstream's host does not survive it) and the spec sanctions
            // that only for a deliberate branch save.
            const branches = shaped || requested.some(([, branch]) => branch !== null) ? requested : []
            // A branch has nowhere to go on an entry written the live-only way, so the shape comes first
            if (branches.length > 0 && !shaped) {
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

            if (change.credential !== undefined) {
                if (change.credential === null) doc.deleteIn(['projects', change.id, 'credential'])
                else doc.setIn(['projects', change.id, 'credential'], change.credential)
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

    // Plain doc.toString(): yaml's flowCollectionPadding option is whole-document, not per-node, so
    // turning it off to make one freshly-written list read "[lifecycle, env]" instead of "[ lifecycle,
    // env ]" would also reformat every other flow collection already in the file, e.g. every untouched
    // "services: { role: site }" on every write, including one as routine as set-deployed after a
    // deploy. The writer exists to keep the operator's hand-written formatting intact; that reformat is
    // a worse breach of that than a stray space is. What the plan actually needs is flow style rather
    // than a block sequence (see the capabilities case above); the padding is the library's default to
    // live with, not ours to fight.
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

        // The file this write is about to replace already has an owner and a mode: the operator's own,
        // or an earlier write's. This is read before the temp file is created so both can be carried
        // across below. On the live dedi, the operator's file was -rw-rw-r-- 1000:1000; the writer, root,
        // created its replacement with no explicit mode or ownership, which came out -rw-rw---- root:root
        // (the process umask, not any deliberate choice). The api container (uid 1000, mounted read-only)
        // could not open that file, so every reload failed EACCES, hostd kept serving the registry it had
        // loaded at boot, and the portal showed the operator a registry that no longer existed. That was
        // the first write this writer had ever made on that machine; provisioning and deploys share it,
        // so either of those would have done the same. If the original cannot even be stat'd, there is no
        // safe mode or ownership to copy and no way to know whether the write would repeat that outage,
        // so this refuses rather than guess: the writer already refuses to write anything hostd would not
        // load, and a file nothing else can read is that same failure by another door.
        let original: { mode: number, uid: number, gid: number }
        try {
            original = await this.fs.stat(this.path)
        } catch (error) {
            return { ok: false, problem: `the registry's permissions could not be read: ${describeError(error)}` }
        }

        // Same directory, so the rename is atomic: a crash leaves either the old file or the new one. A
        // random suffix, so the name cannot be guessed and pre-planted as a symlink by anything else that
        // can write into this directory, and 'wx' (O_CREAT | O_EXCL), which fails on anything already at
        // that path, symlink or not, rather than opening through it. Same defense as env-files.ts's own
        // temp file.
        const temporary = this.path.replace(/([^/]+)$/, `.$1.${randomBytes(6).toString('hex')}.tmp`)
        try {
            await this.fs.writeFile(temporary, applied.text, { flag: 'wx' })
            // Masked to the nine permission bits: stat can report more (the regular-file bit, a stray
            // setuid bit), none of which belongs on a mode passed to chmod.
            await this.fs.chmod(temporary, original.mode & 0o777)
            try {
                await this.fs.chown(temporary, original.uid, original.gid)
            } catch (error) {
                // This process is root on the live dedi, where chown always succeeds. Off it (a non-root
                // dev run, or this test suite), the temp file was just created by this same process, so
                // asking to chown it to the identity it already has is not a real change, and some
                // platforms refuse even that confirmation to an unprivileged caller. That refusal is not
                // a reason to fail a write whose content and mode already landed correctly; any other
                // chown failure is real and must still fail the write.
                const isNoop = process.getuid?.() === original.uid && process.getgid?.() === original.gid
                if (!isNoop) throw error
            }
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            await this.fs.unlink(temporary).catch(() => {})
            return { ok: false, problem: `the registry could not be written: ${describeError(error)}` }
        }
        return { ok: true }
    }
}
