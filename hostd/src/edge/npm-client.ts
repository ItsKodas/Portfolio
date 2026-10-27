// The only code that talks to Nginx Proxy Manager's REST API. It owns the login: one token is reused,
// refreshed before it lapses, and a 401 (NPM restarted, token revoked) costs exactly one fresh login and
// one retry, never a loop. Neither the secret nor a token is ever put in an error or a log line.

import { describeError, isRecord } from '../shared/formats.ts'

export type NpmHostKind = 'proxy-hosts' | 'redirection-hosts' | 'dead-hosts'
export type NpmRecord = Record<string, unknown> & { id: number, domain_names: string[], advanced_config: string, meta?: Record<string, unknown> }

export class NpmError extends Error {
    status: number | null
    body: string
    constructor(message: string, status: number | null, body = '') {
        super(message)
        this.name = 'NpmError'
        this.status = status
        this.body = body
    }
}

export type NpmClientOptions = { url: string, identity: string, secret: string, fetch?: typeof fetch, now?: () => number, timeoutMs?: number }

export const NPM_TIMEOUT_MS = 30_000
// Refresh once fewer than this remain, so a call never starts on a token about to die.
const REFRESH_WITHIN_MS = 10 * 60_000

type Session = { token: string, expiresAt: number }
type Reply = { status: number, text: string }

export class NpmClient {
    private readonly base: string
    private readonly identity: string
    private readonly secret: string
    private readonly doFetch: typeof fetch
    private readonly now: () => number
    private readonly timeoutMs: number
    private session: Session | null = null
    private lastSuccess: number | null = null

    constructor(options: NpmClientOptions) {
        this.base = options.url.replace(/\/+$/, '')
        this.identity = options.identity
        this.secret = options.secret
        this.doFetch = options.fetch ?? fetch
        this.now = options.now ?? Date.now
        this.timeoutMs = options.timeoutMs ?? NPM_TIMEOUT_MS
    }

    async list(kind: NpmHostKind): Promise<NpmRecord[]> {
        return await this.json(await this.authed('GET', `/nginx/${kind}`)) as NpmRecord[]
    }

    async get(kind: NpmHostKind, id: number): Promise<NpmRecord | null> {
        const reply = await this.authed('GET', `/nginx/${kind}/${id}`, undefined, true)
        return reply.status === 404 ? null : await this.json(reply) as NpmRecord
    }

    async create(kind: NpmHostKind, body: Record<string, unknown>): Promise<NpmRecord> {
        return await this.json(await this.authed('POST', `/nginx/${kind}`, body)) as NpmRecord
    }

    async update(kind: NpmHostKind, id: number, body: Record<string, unknown>): Promise<NpmRecord> {
        return await this.json(await this.authed('PUT', `/nginx/${kind}/${id}`, body)) as NpmRecord
    }

    async remove(kind: NpmHostKind, id: number): Promise<void> {
        await this.authed('DELETE', `/nginx/${kind}/${id}`)
    }

    async certificateIds(): Promise<number[]> {
        const records = await this.json(await this.authed('GET', '/nginx/certificates'))
        if (!Array.isArray(records)) throw new NpmError('NPM answered /nginx/certificates with something other than a list', null)
        // Deleted certificates are not normally listed, but one that is must not count as live.
        return records.filter(record => isRecord(record) && !record.is_deleted && typeof record.id === 'number').map(record => record.id as number)
    }

    // Milliseconds since NPM last answered successfully, null if it never has. Health reads this.
    ageOfLastSuccess(): number | null {
        return this.lastSuccess === null ? null : this.now() - this.lastSuccess
    }

    private json(reply: Reply): unknown {
        try {
            return JSON.parse(reply.text)
        } catch {
            throw new NpmError('NPM sent an unreadable reply', reply.status, reply.text)
        }
    }

    // One round trip. A transport failure or timeout becomes an NpmError naming the path.
    private async send(method: string, path: string, body: unknown, token: string | null): Promise<Reply> {
        const headers: Record<string, string> = {}
        if (body !== undefined) headers['Content-Type'] = 'application/json'
        if (token) headers.Authorization = `Bearer ${token}`
        // A ref'd timer rather than AbortSignal.timeout, whose timer is unref'd: with nothing else holding the
        // event loop open, the process could exit before the abort fired and the hang would never end in an error.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), this.timeoutMs)
        try {
            const response = await this.doFetch(`${this.base}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            })
            return { status: response.status, text: await response.text() }
        } catch (error) {
            const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
            throw new NpmError(timedOut ? `NPM did not answer ${method} ${path} within ${this.timeoutMs / 1000} seconds` : `NPM ${method} ${path} failed: ${describeError(error)}`, null)
        } finally {
            clearTimeout(timer)
        }
    }

    private fail(method: string, path: string, reply: Reply): NpmError {
        return new NpmError(`NPM answered ${method} ${path} with ${reply.status}`, reply.status, reply.text)
    }

    private readSession(reply: Reply, method: string, path: string): Session {
        if (reply.status < 200 || reply.status >= 300) throw this.fail(method, path, reply)
        let parsed: unknown
        try {
            parsed = JSON.parse(reply.text)
        } catch {
            parsed = null
        }
        if (!isRecord(parsed) || typeof parsed.token !== 'string' || typeof parsed.expires !== 'string' || Number.isNaN(Date.parse(parsed.expires))) {
            throw new NpmError(`NPM sent an unreadable reply to ${method} ${path}`, reply.status)
        }
        return { token: parsed.token, expiresAt: Date.parse(parsed.expires) }
    }

    private async login(): Promise<Session> {
        const reply = await this.send('POST', '/tokens', { identity: this.identity, secret: this.secret }, null)
        this.session = this.readSession(reply, 'POST', '/tokens')
        return this.session
    }

    private async ensureSession(): Promise<Session> {
        const session = this.session
        if (!session) return await this.login()
        if (session.expiresAt - this.now() >= REFRESH_WITHIN_MS) return session
        try {
            const reply = await this.send('GET', '/tokens', undefined, session.token)
            this.session = this.readSession(reply, 'GET', '/tokens')
            return this.session
        } catch {
            // A refused or failed refresh is not fatal while a login can still work.
            return await this.login()
        }
    }

    // Any non-2xx throws, except a 404 when the caller asked for it (get answers null on one).
    private async authed(method: string, path: string, body?: unknown, allow404 = false): Promise<Reply> {
        let session = await this.ensureSession()
        let reply = await this.send(method, path, body, session.token)
        if (reply.status === 401) {
            session = await this.login()
            reply = await this.send(method, path, body, session.token)
        }
        if (allow404 && reply.status === 404) return reply
        if (reply.status < 200 || reply.status >= 300) throw this.fail(method, path, reply)
        this.lastSuccess = this.now()
        return reply
    }
}
