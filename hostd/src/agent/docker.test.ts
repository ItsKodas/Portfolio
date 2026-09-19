import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import {
    containersPath, logsPath, checkedId, createDockerApi, pickPerService, buildServiceStatuses,
    type ContainerInspect, type ContainerSummary,
} from './docker.ts'
import { parseRegistry } from '../shared/registry.ts'

const ID = 'a'.repeat(64)

describe('paths', () => {
    it('filters containers by the compose project label', () => {
        const path = containersPath('acme')
        assert.ok(path.startsWith('/containers/json?all=1&filters='))
        const filters = JSON.parse(decodeURIComponent(path.split('filters=')[1] ?? ''))
        assert.deepEqual(filters, { label: ['com.docker.compose.project=acme'] })
    })

    it('asks for timestamped stdout and stderr with the requested tail, since and follow', () => {
        const query = new URLSearchParams(logsPath(ID, { tail: 50, since: 1700000000.5, follow: true }).split('?')[1])
        assert.deepEqual(Object.fromEntries(query), { stdout: '1', stderr: '1', timestamps: '1', tail: '50', follow: '1', since: '1700000000.5' })
    })

    it('omits since when there is none', () => {
        assert.equal(logsPath(ID, { tail: 0, since: null, follow: false }).includes('since'), false)
    })

    it('refuses to put anything but a container id into a path', () => {
        assert.equal(checkedId(ID), ID)
        for (const id of ['../../info', 'abc', 'A'.repeat(64)]) assert.throws(() => checkedId(id), /malformed container id/, id)
    })
})

// Stands in for http.request: records the options and answers with the given status and body.
function fakeRequest(status: number, body: string, fail?: Error) {
    const calls: RequestOptions[] = []
    const request = (options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
        calls.push(options)
        const req = Object.assign(new EventEmitter(), {
            setTimeout() { return req },
            destroy() { return req },
            end() {
                setImmediate(() => {
                    if (fail) {
                        req.emit('error', fail)
                        return
                    }
                    const response = Object.assign(new PassThrough(), { statusCode: status })
                    callback(response as unknown as IncomingMessage)
                    response.end(body)
                })
                return req
            },
        })
        return req as unknown as ClientRequest
    }
    return { request, calls }
}

describe('createDockerApi', () => {
    it('talks to the socket it was given', async () => {
        const { request, calls } = fakeRequest(200, '[]')
        await createDockerApi('/var/run/docker.sock', request).listProjectContainers('acme')
        assert.equal(calls[0]?.socketPath, '/var/run/docker.sock')
        assert.equal(calls[0]?.path, containersPath('acme'))
        assert.equal(calls[0]?.method, 'GET')
    })

    it('parses JSON answers', async () => {
        const { request } = fakeRequest(200, JSON.stringify({ Id: ID }))
        assert.deepEqual(await createDockerApi('/s', request).inspect(ID), { Id: ID })
    })

    it('turns a non-200 answer into an error naming the endpoint', async () => {
        const { request } = fakeRequest(404, '{"message":"No such container"}')
        await assert.rejects(createDockerApi('/s', request).inspect(ID), /Docker API \/containers\/a+\/json answered 404/)
    })

    it('pings true on 200 and false when the socket is not there', async () => {
        assert.equal(await createDockerApi('/s', fakeRequest(200, 'OK').request).ping(), true)
        assert.equal(await createDockerApi('/s', fakeRequest(0, '', new Error('connect ENOENT')).request).ping(), false)
    })

    it('returns the log response as a stream', async () => {
        const { request } = fakeRequest(200, 'bytes')
        const stream = await createDockerApi('/s', request).logs(ID, { tail: 10, since: null, follow: false })
        let text = ''
        for await (const chunk of stream) text += String(chunk)
        assert.equal(text, 'bytes')
    })

    it('rejects a malformed container id in inspect as a promise, not a synchronous throw', async () => {
        await assert.rejects(createDockerApi('/s', fakeRequest(200, '{}').request).inspect('../../info'), /malformed container id/)
    })

    // A wedged daemon that accepts the connection and never answers must not hold a follow slot (and the
    // connection) forever. The header wait is bounded; once headers do arrive the timeout is cleared, so a
    // legitimately idle follow stream is never killed later for inactivity.
    it('rejects rather than hanging when the daemon never answers the logs request', async () => {
        let firedTimeout: (() => void) | null = null
        let destroyedWith: Error | undefined
        const request = (_options: RequestOptions, _callback: (response: IncomingMessage) => void): ClientRequest => {
            const req = Object.assign(new EventEmitter(), {
                setTimeout(_ms: number, cb: () => void) {
                    firedTimeout = cb
                    return req
                },
                destroy(error?: Error) {
                    destroyedWith = error
                    req.emit('error', error ?? new Error('destroyed'))
                    return req
                },
                end() { return req }, // the daemon accepted the connection but never calls the response callback
            })
            return req as unknown as ClientRequest
        }
        const pending = createDockerApi('/s', request).logs(ID, { tail: 10, since: null, follow: true })
        assert.ok(firedTimeout, 'a timeout must be armed for the header wait')
        ;(firedTimeout as () => void)()
        await assert.rejects(pending, /Docker API timed out on \/containers\/a+\/logs/)
        assert.ok(destroyedWith)
    })
})

describe('pickPerService', () => {
    it('keys containers by compose service and prefers a running one', () => {
        const containers: ContainerSummary[] = [
            { Id: '1', State: 'exited', Labels: { 'com.docker.compose.service': 'web' } },
            { Id: '2', State: 'running', Labels: { 'com.docker.compose.service': 'web' } },
            { Id: '3', State: 'running', Labels: { 'com.docker.compose.service': 'db' } },
            { Id: '4', State: 'running' },
        ]
        const picked = pickPerService(containers)
        assert.deepEqual([...picked].map(([service, c]) => [service, c.Id]), [['web', '2'], ['db', '3']])
    })
})

describe('buildServiceStatuses', () => {
    const project = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
      appdb: { role: database, engine: sqlite, file: data/app.db }
`).projects.get('acme')!

    const running: ContainerInspect = {
        Id: ID,
        RestartCount: 2,
        Config: { Tty: false, Image: 'acme-web:latest' },
        State: { Status: 'running', StartedAt: '2026-09-20T00:00:00Z', Health: { Status: 'healthy' } },
    }

    it('reports every registered compose service in registry order, missing ones included', () => {
        const statuses = buildServiceStatuses(project, new Map([['web', running]]))
        assert.deepEqual(statuses, [
            { service: 'web', role: 'site', state: 'running', health: 'healthy', startedAt: '2026-09-20T00:00:00Z', restartCount: 2, image: 'acme-web:latest' },
            { service: 'db', role: 'database', state: 'missing', health: null, startedAt: null, restartCount: null, image: null },
        ])
    })

    it('reports no health when there is no healthcheck, and no start time for a never-started container', () => {
        const created: ContainerInspect = { ...running, RestartCount: 0, State: { Status: 'created', StartedAt: '0001-01-01T00:00:00Z' } }
        const [web] = buildServiceStatuses(project, new Map([['web', created]]))
        assert.equal(web?.health, null)
        assert.equal(web?.startedAt, null)
    })
})
