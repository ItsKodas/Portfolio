import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough, Readable } from 'node:stream'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import {
    containersPath, logsPath, checkedId, createDockerApi, pickPerService, buildServiceStatuses,
    groupByProject, publishedHostPorts, ALL_CONTAINERS_PATH,
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

    it('asks for every container, unfiltered, to see every published port on the box', () => {
        assert.equal(ALL_CONTAINERS_PATH, '/containers/json?all=1')
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

describe('groupByProject', () => {
    it('splits one listing by compose project and drops what is not ours', () => {
        const containers: ContainerSummary[] = [
            { Id: '1', State: 'running', Labels: { 'com.docker.compose.project': 'acme', 'com.docker.compose.service': 'web' } },
            { Id: '2', State: 'running', Labels: { 'com.docker.compose.project': 'acme', 'com.docker.compose.service': 'db' } },
            { Id: '3', State: 'running', Labels: { 'com.docker.compose.project': 'quiet', 'com.docker.compose.service': 'web' } },
            // Started by hand, or by something that is not compose at all.
            { Id: '4', State: 'running' },
        ]
        const grouped = groupByProject(containers)
        assert.deepEqual([...grouped].map(([project, list]) => [project, list.map(c => c.Id)]), [['acme', ['1', '2']], ['quiet', ['3']]])
        assert.deepEqual(grouped.get('ghost'), undefined)
    })
})

describe('publishedHostPorts', () => {
    it('collects a port published on a specific interface', () => {
        const containers: ContainerSummary[] = [
            { Id: '1', State: 'running', Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: 5010, Type: 'tcp' }] },
        ]
        assert.deepEqual(publishedHostPorts(containers), new Set([5010]))
    })

    it('collects a port published on every interface', () => {
        const containers: ContainerSummary[] = [
            { Id: '1', State: 'running', Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 5011, Type: 'tcp' }] },
        ]
        assert.deepEqual(publishedHostPorts(containers), new Set([5011]))
    })

    it('ignores a port the container exposes internally without publishing to the host', () => {
        const containers: ContainerSummary[] = [
            { Id: '1', State: 'running', Ports: [{ PrivatePort: 5432, Type: 'tcp' }] },
        ]
        assert.deepEqual(publishedHostPorts(containers), new Set())
    })

    it('ignores a container with no Ports at all', () => {
        assert.deepEqual(publishedHostPorts([{ Id: '1', State: 'running' }]), new Set())
    })

    it('collects from every container, deduplicating repeats', () => {
        const containers: ContainerSummary[] = [
            { Id: '1', State: 'running', Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: 5010, Type: 'tcp' }] },
            { Id: '2', State: 'running', Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 5010, Type: 'tcp' }, { IP: '0.0.0.0', PrivatePort: 443, PublicPort: 5011, Type: 'tcp' }] },
        ]
        assert.deepEqual(publishedHostPorts(containers), new Set([5010, 5011]))
    })
})

// One multiplexed frame, exactly as Docker writes them: type, three zero bytes, a big-endian length.
function frame(type: 1 | 2, text: string): Buffer {
    const payload = Buffer.from(text)
    const header = Buffer.alloc(8)
    header[0] = type
    header.writeUInt32BE(payload.length, 4)
    return Buffer.concat([header, payload])
}

// A container id shape, standing in for the id Docker actually assigns an exec instance.
const EXEC_ID = 'e'.repeat(64)

function execSetup(options: { exitCode: number, frames: Buffer[], execId?: string }) {
    const execId = options.execId ?? EXEC_ID
    const calls: Array<{ path: string, method: string, body: string }> = []
    const request = (opts: any, callback: (response: any) => void) => {
        let body = ''
        const response = new PassThrough() as any
        response.statusCode = 200
        const req: any = {
            on: () => req,
            setTimeout: () => req,
            write: (chunk: string) => { body += chunk },
            end: (chunk?: string) => {
                if (chunk) body += chunk
                calls.push({ path: opts.path, method: opts.method, body })
                queueMicrotask(() => {
                    if (opts.path === '/containers/' + ID + '/exec') {
                        response.end(JSON.stringify({ Id: execId }))
                    } else if (opts.path === '/exec/' + execId + '/start') {
                        for (const chunk of options.frames) response.write(chunk)
                        response.end()
                    } else {
                        response.end(JSON.stringify({ ExitCode: options.exitCode, Running: false }))
                    }
                })
                callback(response)
            },
        }
        return req
    }
    return { request, calls }
}

describe('exec', () => {
    it('sends the argv, streams stdout to the caller and returns the exit code', async () => {
        const { request, calls } = execSetup({ exitCode: 0, frames: [frame(1, 'CREATE TABLE'), frame(1, ' one;')] })
        const docker = createDockerApi('/var/run/docker.sock', request as any)
        const chunks: Buffer[] = []
        const result = await docker.exec(ID, ['sh', '-c', 'pg_dumpall'], chunk => { chunks.push(chunk) })
        assert.equal(Buffer.concat(chunks).toString(), 'CREATE TABLE one;')
        assert.deepEqual(result, { exitCode: 0, stderr: '' })
        assert.deepEqual(JSON.parse(calls[0]!.body), {
            AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: ['sh', '-c', 'pg_dumpall'],
        })
        assert.equal(calls[0]!.method, 'POST')
    })

    it('collects stderr and reports a non-zero exit', async () => {
        const { request } = execSetup({ exitCode: 1, frames: [frame(2, 'could not connect')] })
        const docker = createDockerApi('/var/run/docker.sock', request as any)
        const result = await docker.exec(ID, ['sh', '-c', 'pg_dumpall'], () => {})
        assert.deepEqual(result, { exitCode: 1, stderr: 'could not connect' })
    })

    it('refuses a malformed container id before it reaches a URL', async () => {
        const { request } = execSetup({ exitCode: 0, frames: [] })
        const docker = createDockerApi('/var/run/docker.sock', request as any)
        await assert.rejects(() => docker.exec('../../etc', ['sh'], () => {}), /refusing malformed container id/)
    })

    it('refuses a malformed exec id from Docker before it reaches a URL', async () => {
        const { request } = execSetup({ exitCode: 0, frames: [], execId: 'exec123' })
        const docker = createDockerApi('/var/run/docker.sock', request as any)
        await assert.rejects(() => docker.exec(ID, ['sh', '-c', 'true'], () => {}), /refusing malformed container id/)
    })
})

// Stands in for Docker's hijacked exec connection: it answers the start call with 101 and a socket that
// records what is written to it, and only sends the command's output once the write side is half-closed,
// which is what a real `psql` fed a dump on stdin does.
// exitEarly stands in for a command that fails before reading all its input (psql with a bad password):
// the first write is answered with that output, and the next write fails as the closed connection would.
function execStdinSetup(options: { exitCode: number, frames: Buffer[], head?: Buffer, startStatus?: number, exitEarly?: Buffer }) {
    const calls: Array<{ path: string, headers: Record<string, string>, body: string }> = []
    const written: Buffer[] = []
    let halfClosed = false
    const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
            written.push(chunk as Buffer)
            if (options.exitEarly === undefined) return callback()
            if (written.length === 1) {
                socket.push(options.exitEarly)
                return callback()
            }
            setImmediate(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
        },
        final(callback) {
            halfClosed = true
            for (const chunk of options.frames) socket.push(chunk)
            socket.push(null)
            callback()
        },
    })
    let socketTimeout: number | null = null
    Object.assign(socket, { setTimeout: (ms: number) => { socketTimeout = ms; return socket } })
    const request = (opts: any, callback: (response: any) => void) => {
        let body = ''
        const listeners: Record<string, (...args: any[]) => void> = {}
        const req: any = {
            on: (event: string, listener: (...args: any[]) => void) => { listeners[event] = listener; return req },
            setTimeout: () => req,
            end: (chunk?: string) => {
                if (chunk) body += chunk
                calls.push({ path: opts.path, headers: opts.headers ?? {}, body })
                queueMicrotask(() => {
                    if (opts.path === '/containers/' + ID + '/exec') {
                        const response = new PassThrough() as any
                        response.statusCode = 201
                        callback(response)
                        response.end(JSON.stringify({ Id: EXEC_ID }))
                    } else if (opts.path === '/exec/' + EXEC_ID + '/start') {
                        const response = new PassThrough() as any
                        response.statusCode = options.startStatus ?? 101
                        if (response.statusCode === 101) listeners.upgrade!(response, socket, options.head ?? Buffer.alloc(0))
                        else {
                            callback(response)
                            response.end('{"message":"No such exec instance"}')
                        }
                    } else {
                        const response = new PassThrough() as any
                        response.statusCode = 200
                        callback(response)
                        response.end(JSON.stringify({ ExitCode: options.exitCode, Running: false }))
                    }
                })
            },
        }
        return req
    }
    return { request, calls, written, halfClosed: () => halfClosed, socketTimeout: () => socketTimeout }
}

describe('exec with stdin', () => {
    it('attaches stdin, writes the stream to the hijacked connection and half-closes it', async () => {
        const setup = execStdinSetup({ exitCode: 0, frames: [frame(1, 'CREATE DATABASE'), frame(2, 'NOTICE: hi')] })
        const docker = createDockerApi('/var/run/docker.sock', setup.request as any)
        const stdout: Buffer[] = []
        const result = await docker.exec(ID, ['sh', '-c', 'psql'], chunk => { stdout.push(chunk) }, Readable.from([Buffer.from('CREATE '), Buffer.from('TABLE t;\n')]))
        assert.equal(Buffer.concat(setup.written).toString(), 'CREATE TABLE t;\n')
        assert.equal(setup.halfClosed(), true)
        assert.equal(setup.socketTimeout(), 0, 'a slow load is never cut off for taking its time')
        assert.equal(Buffer.concat(stdout).toString(), 'CREATE DATABASE')
        assert.deepEqual(result, { exitCode: 0, stderr: 'NOTICE: hi' })
        assert.deepEqual(JSON.parse(setup.calls[0]!.body), {
            AttachStdout: true, AttachStderr: true, AttachStdin: true, Tty: false, Cmd: ['sh', '-c', 'psql'],
        })
        const start = setup.calls[1]!
        assert.equal(start.path, '/exec/' + EXEC_ID + '/start')
        assert.equal(start.headers.connection, 'Upgrade')
        assert.equal(start.headers.upgrade, 'tcp')
        assert.deepEqual(JSON.parse(start.body), { Detach: false, Tty: false })
    })

    it('reads output that arrived with the upgrade response itself', async () => {
        const setup = execStdinSetup({ exitCode: 3, frames: [frame(2, ' failed')], head: frame(2, 'psql:') })
        const docker = createDockerApi('/var/run/docker.sock', setup.request as any)
        const result = await docker.exec(ID, ['sh', '-c', 'psql'], () => {}, Readable.from([Buffer.from('x')]))
        assert.deepEqual(result, { exitCode: 3, stderr: 'psql: failed' })
    })

    it("reports the command's own failure, not the write error, when it exits before reading everything", async () => {
        const setup = execStdinSetup({ exitCode: 2, frames: [], exitEarly: frame(2, 'FATAL:  password authentication failed for user "acme"') })
        const docker = createDockerApi('/var/run/docker.sock', setup.request as any)
        const stdin = Readable.from([Buffer.from('one;\n'), Buffer.from('two;\n'), Buffer.from('three;\n')])
        const result = await docker.exec(ID, ['sh', '-c', 'psql'], () => {}, stdin)
        assert.deepEqual(result, { exitCode: 2, stderr: 'FATAL:  password authentication failed for user "acme"' })
    })

    it('still throws the write error when the command did not fail', async () => {
        const setup = execStdinSetup({ exitCode: 0, frames: [], exitEarly: frame(1, 'ok') })
        const docker = createDockerApi('/var/run/docker.sock', setup.request as any)
        const stdin = Readable.from([Buffer.from('one;\n'), Buffer.from('two;\n')])
        await assert.rejects(() => docker.exec(ID, ['sh', '-c', 'psql'], () => {}, stdin), /EPIPE/)
    })

    it('rejects when Docker will not upgrade the start call', async () => {
        const setup = execStdinSetup({ exitCode: 0, frames: [], startStatus: 404 })
        const docker = createDockerApi('/var/run/docker.sock', setup.request as any)
        await assert.rejects(() => docker.exec(ID, ['sh', '-c', 'psql'], () => {}, Readable.from([Buffer.from('x')])), /exec start answered 404/)
    })

    it('hands every stderr chunk to onStderr, uncapped, and still caps the returned stderr', async () => {
        const noise = Array.from({ length: 120 }, (_, i) => frame(2, `psql:<stdin>:${i}: ERROR:  role "r${i}" already exists\n`))
        const setup = execStdinSetup({ exitCode: 0, frames: [...noise, frame(2, 'psql:<stdin>:999: ERROR:  relation "x" does not exist\n')] })
        const docker = createDockerApi('/var/run/docker.sock', setup.request as any)
        const seen: Buffer[] = []
        const result = await docker.exec(ID, ['sh', '-c', 'psql'], () => {}, Readable.from([Buffer.from('x')]), chunk => { seen.push(chunk) })
        const all = Buffer.concat(seen).toString()
        assert.ok(all.length > 5 * 1024)
        assert.ok(all.endsWith('psql:<stdin>:999: ERROR:  relation "x" does not exist\n'))
        assert.ok(result.stderr.length <= 4096)
        assert.equal(result.stderr.includes('999'), false)
    })

    it('hands stderr to onStderr without stdin too', async () => {
        const { request } = execSetup({ exitCode: 1, frames: [frame(2, 'could not connect')] })
        const docker = createDockerApi('/var/run/docker.sock', request as any)
        const seen: string[] = []
        await docker.exec(ID, ['sh', '-c', 'pg_dumpall'], () => {}, undefined, chunk => { seen.push(chunk.toString()) })
        assert.deepEqual(seen, ['could not connect'])
    })

    it('fails when the stdin stream fails', async () => {
        const setup = execStdinSetup({ exitCode: 0, frames: [] })
        const docker = createDockerApi('/var/run/docker.sock', setup.request as any)
        const broken = new Readable({ read() { this.destroy(new Error('disk read failed')) } })
        await assert.rejects(() => docker.exec(ID, ['sh', '-c', 'psql'], () => {}, broken), /disk read failed/)
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
