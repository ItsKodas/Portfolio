// An in-memory Nginx Proxy Manager for edge's tests, with the two NPM 2.16 behaviours hostd has to
// survive: a duplicate domain is refused, and a write whose nginx config fails `nginx -t` still
// answers 200, with the new values stored and meta.nginx_online false (the host is then offline).
//
// In npmplus mode it behaves as NPMplus does where edge could get it wrong: a write carrying any key
// NPMplus's schema does not allow is refused with a 400 (additionalProperties: false), a PUT changes
// only the keys it sends, and nginx's state is the top-level npmplus_nginx_online/npmplus_nginx_err.
// `fetch` serves the same state over HTTP, so a real NpmClient can be pointed at it: it hands out the
// session (a cookie on NPMplus, a bearer token on NPM), refuses a request without it, and refuses one
// carrying Origin or Sec-Fetch-Site, as NPMplus's backend/app.js does.

import { NpmError, type NpmFlavour, type NpmHostKind, type NpmRecord } from '../npm-client.ts'

export type FakeCall = `${'list' | 'get' | 'create' | 'update' | 'remove'} ${NpmHostKind}${'' | ` ${number}`}` | 'certificates'

const KINDS: NpmHostKind[] = ['proxy-hosts', 'redirection-hosts', 'dead-hosts']
const ONLINE = { nginx_online: true, nginx_err: null }

// NPMplus's write schemas (backend/schema/paths/nginx/*/post.json on develop), certificate request keys
// included. Its own copy, not hosts.ts's, so a mistake there is caught here rather than repeated.
const CERTIFICATE_REQUEST = ['npmplus_reuse_key', 'npmplus_dns_challenge', 'npmplus_dns_provider', 'npmplus_dns_provider_credentials', 'npmplus_propagation_seconds']
export const NPMPLUS_WRITABLE: Partial<Record<NpmHostKind, string[]>> = {
    'proxy-hosts': [
        'domain_names', 'forward_scheme', 'forward_host', 'forward_port', 'certificate_id', 'ssl_forced', 'hsts_enabled', 'hsts_subdomains',
        'npmplus_http3_support', 'npmplus_access_list_ids', 'npmplus_access_list_type', 'npmplus_noindex', 'npmplus_crowdsec_appsec',
        'npmplus_proxy_request_buffering', 'npmplus_proxy_response_buffering', 'npmplus_upstream_compression', 'npmplus_fancyindex',
        'npmplus_x_frame_options', 'npmplus_auth_request', 'npmplus_auth_request_upstream', 'advanced_config', 'npmplus_location_config',
        'npmplus_directory', 'npmplus_mtls_certificate_id', 'npmplus_mtls_verify_client_optional', 'npmplus_mtls_bypass_auth_request', 'locations',
        ...CERTIFICATE_REQUEST,
    ],
    'redirection-hosts': [
        'domain_names', 'forward_http_code', 'forward_scheme', 'forward_domain_name', 'preserve_path', 'certificate_id', 'ssl_forced',
        'hsts_enabled', 'hsts_subdomains', 'npmplus_http3_support', 'advanced_config', 'npmplus_directory', 'npmplus_mtls_certificate_id',
        'npmplus_mtls_verify_client_optional', ...CERTIFICATE_REQUEST,
    ],
}

// What NPMplus gives a new host for every field the create left out.
const NPMPLUS_DEFAULTS: Partial<Record<NpmHostKind, Record<string, unknown>>> = {
    'proxy-hosts': {
        forward_scheme: 'http', certificate_id: 0, ssl_forced: false, hsts_enabled: false, hsts_subdomains: false, npmplus_http3_support: false,
        npmplus_access_list_ids: [], access_lists: [], npmplus_access_list_type: 'any', npmplus_noindex: false, npmplus_crowdsec_appsec: true,
        npmplus_proxy_request_buffering: true, npmplus_proxy_response_buffering: true, npmplus_upstream_compression: false, npmplus_fancyindex: false,
        npmplus_x_frame_options: 'SAMEORIGIN', npmplus_auth_request: 'none', npmplus_auth_request_upstream: '', npmplus_location_config: '',
        npmplus_directory: '', npmplus_mtls_certificate_id: 0, npmplus_mtls_verify_client_optional: false, npmplus_mtls_bypass_auth_request: false,
        locations: [], enabled: true,
    },
    'redirection-hosts': {
        forward_http_code: 301, forward_scheme: 'auto', preserve_path: false, certificate_id: 0, ssl_forced: false, hsts_enabled: false,
        hsts_subdomains: false, npmplus_http3_support: false, npmplus_directory: '', npmplus_mtls_certificate_id: 0,
        npmplus_mtls_verify_client_optional: false, enabled: true,
    },
}

export const SESSION_COOKIE = '__Host-Http-token'

export class FakeNpm {
    readonly flavour: NpmFlavour
    readonly calls: FakeCall[] = []
    // Every write body as it arrived, refused ones included, so a test can check what was sent.
    readonly sent: { call: FakeCall, body: Record<string, unknown> }[] = []
    // HTTP requests refused for a missing session or a cross-site header
    readonly refusedRequests: string[] = []
    certificates: number[] = []
    private session: string | null = null
    private sessions = 0
    private readonly hosts: Record<NpmHostKind, Map<number, NpmRecord>> = {
        'proxy-hosts': new Map(), 'redirection-hosts': new Map(), 'dead-hosts': new Map(),
    }
    private nextId = 100
    // Writes that nginx will reject: the next create or update of that kind stores the record offline.
    private readonly broken: { kind: NpmHostKind, op: 'create' | 'update', err: string }[] = []
    private readonly lost: { kind: NpmHostKind, op: 'create' | 'update' }[] = []

    constructor(options: { flavour?: NpmFlavour } = {}) {
        this.flavour = options.flavour ?? 'npm'
    }

    // Puts a host in place without a call being recorded, as if Koda had made it in the UI.
    seed(kind: NpmHostKind, record: Partial<NpmRecord> & { id: number }): NpmRecord {
        const state = this.flavour === 'npmplus' ? { npmplus_nginx_online: true, npmplus_nginx_err: null } : { meta: { ...ONLINE } }
        const full = { domain_names: [], advanced_config: '', ...state, ...structuredClone(record) } as NpmRecord
        this.hosts[kind].set(full.id, full)
        return structuredClone(full)
    }

    breakNext(kind: NpmHostKind, op: 'create' | 'update', err: string): void {
        this.broken.push({ kind, op, err })
    }

    // The next create or update of that kind is stored, then the call fails as a timeout would: the
    // case where NPM did the write but hostd never heard back.
    loseReplyNext(kind: NpmHostKind, op: 'create' | 'update'): void {
        this.lost.push({ kind, op })
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
        this.sent.push({ call: `create ${kind}`, body: structuredClone(body) })
        this.refuseUnknownKeys(kind, body, 'POST')
        this.refuseDuplicates(body, null)
        const id = this.nextId++
        const defaults = this.flavour === 'npmplus' ? structuredClone(NPMPLUS_DEFAULTS[kind] ?? {}) : {}
        return this.store(kind, 'create', { ...defaults, ...structuredClone(body), id } as NpmRecord)
    }

    async update(kind: NpmHostKind, id: number, body: Record<string, unknown>): Promise<NpmRecord> {
        this.calls.push(`update ${kind} ${id}`)
        this.sent.push({ call: `update ${kind} ${id}`, body: structuredClone(body) })
        const existing = this.hosts[kind].get(id)
        if (!existing) throw new NpmError(`NPM answered PUT /nginx/${kind}/${id} with 404`, 404)
        this.refuseUnknownKeys(kind, body, 'PUT')
        this.refuseDuplicates(body, { kind, id })
        // A PUT only changes what it sends: NPMplus's by schema (minProperties 1, nothing required), and
        // this fake has always merged for NPM too.
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
        if (this.flavour === 'npmplus') {
            record.npmplus_nginx_online = err === null
            record.npmplus_nginx_err = err
        } else {
            record.meta = err === null ? { ...ONLINE } : { nginx_online: false, nginx_err: err }
        }
        this.hosts[kind].set(record.id, record)
        const lost = this.lost.findIndex(entry => entry.kind === kind && entry.op === op)
        if (lost !== -1) {
            this.lost.splice(lost, 1)
            throw new NpmError(`NPM did not answer ${op === 'create' ? 'POST' : 'PUT'} /nginx/${kind} within 30 seconds`, null)
        }
        return structuredClone(record)
    }

    private refuseUnknownKeys(kind: NpmHostKind, body: Record<string, unknown>, method: string): void {
        if (this.flavour !== 'npmplus') return
        const allowed = NPMPLUS_WRITABLE[kind] ?? []
        const unknown = Object.keys(body).filter(key => !allowed.includes(key))
        const empty = method === 'PUT' && Object.keys(body).length === 0
        if (unknown.length === 0 && !empty) return
        const message = empty ? 'data must NOT have fewer than 1 properties' : `data must NOT have additional properties: ${unknown.join(', ')}`
        throw new NpmError(`NPM answered ${method} /nginx/${kind} with 400`, 400, JSON.stringify({ error: { code: 400, message } }))
    }

    // The API over HTTP, for a real NpmClient. Each route calls the method of the same name, so a test
    // that replaces one (npm.create = ...) still sees its replacement used.
    readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
        const url = new URL(String(input))
        const method = init.method ?? 'GET'
        const path = url.pathname.replace(/^\/api/, '')
        const headers = new Headers(init.headers)
        const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
        if (headers.has('origin') || headers.has('sec-fetch-site')) {
            this.refusedRequests.push(`${method} ${path} cross-site`)
            return reply(403, { error: { code: 403, message: 'Invalid origin' } })
        }
        if (path === '/tokens' && method === 'POST') return this.issue()
        if (!this.authorised(headers)) {
            this.refusedRequests.push(`${method} ${path} unauthorised`)
            return reply(401, { error: { code: 401, message: 'Unauthorized' } })
        }
        if (path === '/tokens' && method === 'GET') return this.issue()
        const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
        try {
            if (path === '/nginx/certificates') return reply(200, (await this.certificateIds()).map(id => ({ id })))
            const match = /^\/nginx\/(proxy-hosts|redirection-hosts|dead-hosts)(?:\/(\d+))?$/.exec(path)
            if (!match) return reply(404, { error: { code: 404, message: 'Not Found' } })
            const kind = match[1] as NpmHostKind
            const id = match[2] === undefined ? null : Number(match[2])
            if (id === null && method === 'GET') return reply(200, await this.list(kind))
            if (id === null && method === 'POST') return reply(201, await this.create(kind, body))
            if (id !== null && method === 'GET') {
                const record = await this.get(kind, id)
                return record ? reply(200, record) : reply(404, { error: { code: 404, message: 'Not Found' } })
            }
            if (id !== null && method === 'PUT') return reply(200, await this.update(kind, id, body))
            if (id !== null && method === 'DELETE') {
                await this.remove(kind, id)
                return reply(200, true)
            }
            return reply(404, { error: { code: 404, message: 'Not Found' } })
        } catch (error) {
            // A reply lost after the write is a timeout to the client, the same as the real thing.
            if (error instanceof NpmError && error.status === null) throw new DOMException('The operation timed out', 'TimeoutError')
            if (error instanceof NpmError) return new Response(error.body || JSON.stringify({ error: { message: error.message } }), { status: error.status! })
            throw error
        }
    }) as typeof fetch

    private issue(): Response {
        this.session = `s%3Asession-${++this.sessions}.c2lnbmVk`
        const expires = new Date(Date.now() + 3_600_000).toISOString()
        if (this.flavour !== 'npmplus') return new Response(JSON.stringify({ token: this.session, expires }), { status: 200 })
        const headers = new Headers()
        headers.append('Set-Cookie', `${SESSION_COOKIE}=${this.session}; Path=/; Expires=${new Date(expires).toUTCString()}; HttpOnly; Secure; SameSite=Strict`)
        return new Response(JSON.stringify({ expires }), { status: 200, headers })
    }

    private authorised(headers: Headers): boolean {
        if (this.session === null) return false
        if (this.flavour === 'npmplus') return headers.get('cookie') === `${SESSION_COOKIE}=${this.session}` && !headers.has('authorization')
        return headers.get('authorization') === `Bearer ${this.session}`
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
