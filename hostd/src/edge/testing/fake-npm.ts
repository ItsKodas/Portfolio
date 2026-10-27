// An in-memory Nginx Proxy Manager for edge's tests, with the two NPM 2.16 behaviours hostd has to
// survive: a duplicate domain is refused, and a write whose nginx config fails `nginx -t` still
// answers 200, with the new values stored and meta.nginx_online false (the host is then offline).

import { NpmError, type NpmHostKind, type NpmRecord } from '../npm-client.ts'

export type FakeCall = `${'list' | 'get' | 'create' | 'update' | 'remove'} ${NpmHostKind}${'' | ` ${number}`}` | 'certificates'

const KINDS: NpmHostKind[] = ['proxy-hosts', 'redirection-hosts', 'dead-hosts']
const ONLINE = { nginx_online: true, nginx_err: null }

export class FakeNpm {
    readonly calls: FakeCall[] = []
    certificates: number[] = []
    private readonly hosts: Record<NpmHostKind, Map<number, NpmRecord>> = {
        'proxy-hosts': new Map(), 'redirection-hosts': new Map(), 'dead-hosts': new Map(),
    }
    private nextId = 100
    // Writes that nginx will reject: the next create or update of that kind stores the record offline.
    private readonly broken: { kind: NpmHostKind, op: 'create' | 'update', err: string }[] = []

    // Puts a host in place without a call being recorded, as if Koda had made it in the UI.
    seed(kind: NpmHostKind, record: Partial<NpmRecord> & { id: number }): NpmRecord {
        const full = { domain_names: [], advanced_config: '', meta: { ...ONLINE }, ...structuredClone(record) } as NpmRecord
        this.hosts[kind].set(full.id, full)
        return structuredClone(full)
    }

    breakNext(kind: NpmHostKind, op: 'create' | 'update', err: string): void {
        this.broken.push({ kind, op, err })
    }

    // Every host, for a test that wants to compare the whole state before and after.
    snapshot(): Record<NpmHostKind, NpmRecord[]> {
        const out = {} as Record<NpmHostKind, NpmRecord[]>
        for (const kind of KINDS) out[kind] = [...this.hosts[kind].values()].sort((a, b) => a.id - b.id).map(record => structuredClone(record))
        return out
    }

    async list(kind: NpmHostKind): Promise<NpmRecord[]> {
        this.calls.push(`list ${kind}`)
        return [...this.hosts[kind].values()].map(record => structuredClone(record))
    }

    async get(kind: NpmHostKind, id: number): Promise<NpmRecord | null> {
        this.calls.push(`get ${kind} ${id}`)
        const record = this.hosts[kind].get(id)
        return record ? structuredClone(record) : null
    }

    async create(kind: NpmHostKind, body: Record<string, unknown>): Promise<NpmRecord> {
        this.calls.push(`create ${kind}`)
        this.refuseDuplicates(body, null)
        const id = this.nextId++
        return this.store(kind, 'create', { ...structuredClone(body), id } as NpmRecord)
    }

    async update(kind: NpmHostKind, id: number, body: Record<string, unknown>): Promise<NpmRecord> {
        this.calls.push(`update ${kind} ${id}`)
        const existing = this.hosts[kind].get(id)
        if (!existing) throw new NpmError(`NPM answered PUT /nginx/${kind}/${id} with 404`, 404)
        this.refuseDuplicates(body, { kind, id })
        return this.store(kind, 'update', { ...existing, ...structuredClone(body), id } as NpmRecord)
    }

    async remove(kind: NpmHostKind, id: number): Promise<void> {
        this.calls.push(`remove ${kind} ${id}`)
        if (!this.hosts[kind].delete(id)) throw new NpmError(`NPM answered DELETE /nginx/${kind}/${id} with 404`, 404)
    }

    async certificateIds(): Promise<number[]> {
        this.calls.push('certificates')
        return [...this.certificates]
    }

    private store(kind: NpmHostKind, op: 'create' | 'update', record: NpmRecord): NpmRecord {
        const at = this.broken.findIndex(entry => entry.kind === kind && entry.op === op)
        const err = at === -1 ? null : this.broken.splice(at, 1)[0]!.err
        record.meta = err === null ? { ...ONLINE } : { nginx_online: false, nginx_err: err }
        this.hosts[kind].set(record.id, record)
        return structuredClone(record)
    }

    private refuseDuplicates(body: Record<string, unknown>, self: { kind: NpmHostKind, id: number } | null): void {
        const wanted = Array.isArray(body.domain_names) ? body.domain_names.map(name => String(name).toLowerCase()) : []
        for (const kind of KINDS) {
            for (const record of this.hosts[kind].values()) {
                if (self && self.kind === kind && self.id === record.id) continue
                const clash = record.domain_names.find(name => wanted.includes(name.toLowerCase()))
                if (clash) throw new NpmError('NPM answered with 400', 400, JSON.stringify({ error: { code: 400, message: `${clash} is already in use` } }))
            }
        }
    }
}
