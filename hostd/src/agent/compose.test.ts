import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn as nodeSpawn } from 'node:child_process'
import {
    lifecycleArgv, configArgv, runLifecycle, resolveCompose, resolveNewProject, composeNameProblem, createSpawnRunner, tail,
    LIFECYCLE_TIMEOUT_MS, OUTPUT_TAIL_BYTES, type Runner, type RunResult,
} from './compose.ts'
import { parseRegistry } from '../shared/registry.ts'

const project = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
`).projects.get('acme')!

function runnerReturning(result: Partial<RunResult>) {
    const calls: Array<{ command: string, args: string[], timeoutMs: number }> = []
    const run: Runner = async (command, args, timeoutMs) => {
        calls.push({ command, args, timeoutMs })
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result }
    }
    return { run, calls }
}

describe('argv', () => {
    const base = ['compose', '--project-directory', '/var/www/acme', '-f', '/var/www/acme/docker-compose.yml']

    // up rather than start, so a start also works after a down or a reboot; never builds or pulls, so a
    // start cannot fetch anything new.
    it('starts with up, never building or pulling', () => {
        assert.deepEqual(lifecycleArgv(project, 'start'), [...base, 'up', '-d', '--no-build', '--pull', 'never'])
    })

    it('stops and restarts in place', () => {
        assert.deepEqual(lifecycleArgv(project, 'stop'), [...base, 'stop'])
        assert.deepEqual(lifecycleArgv(project, 'restart'), [...base, 'restart'])
    })

    // --no-env-resolution keeps env_file as a path list instead of compose inlining every value (a
    // database password among them) into the resolved JSON this command captures.
    it('resolves the configuration as JSON, without inlining env file values', () => {
        assert.deepEqual(configArgv(project), [...base, 'config', '--no-env-resolution', '--format', 'json'])
    })
})

describe('runLifecycle', () => {
    it('runs docker with the lifecycle argv and timeout', async () => {
        const { run, calls } = runnerReturning({ stderr: 'Container acme-web-1 Started' })
        const result = await runLifecycle(project, 'start', run)
        assert.deepEqual(result, { ok: true, output: 'Container acme-web-1 Started' })
        assert.deepEqual(calls, [{ command: 'docker', args: lifecycleArgv(project, 'start'), timeoutMs: LIFECYCLE_TIMEOUT_MS }])
    })

    it('reports a non-zero exit with the output', async () => {
        const { run } = runnerReturning({ exitCode: 1, stderr: 'no such image' })
        assert.deepEqual(await runLifecycle(project, 'start', run), { ok: false, message: 'start exited with code 1', output: 'no such image' })
    })

    it('reports a timeout', async () => {
        const { run } = runnerReturning({ exitCode: null, timedOut: true })
        assert.deepEqual(await runLifecycle(project, 'restart', run), { ok: false, message: 'restart timed out after 120 seconds', output: '' })
    })

    it('reports a command that could not run at all', async () => {
        const { run } = runnerReturning({ exitCode: null, stderr: 'spawn docker ENOENT' })
        assert.deepEqual(await runLifecycle(project, 'stop', run), { ok: false, message: 'stop could not run', output: 'spawn docker ENOENT' })
    })

    it('keeps only the last 4 KB of output', async () => {
        const { run } = runnerReturning({ stdout: 'x'.repeat(10_000) + 'END' })
        const result = await runLifecycle(project, 'stop', run)
        assert.equal(Buffer.byteLength(result.output), OUTPUT_TAIL_BYTES)
        assert.ok(result.output.endsWith('END'))
    })
})

describe('tail', () => {
    it('returns short text unchanged', () => {
        assert.equal(tail('abc', 10), 'abc')
    })

    it('keeps the end of long text', () => {
        assert.equal(tail('abcdef', 3), 'def')
    })
})

describe('resolveCompose', () => {
    it('parses the resolved configuration', async () => {
        const { run, calls } = runnerReturning({ stdout: JSON.stringify({ name: 'acme', services: { web: {} } }) })
        assert.deepEqual(await resolveCompose(project, run), { ok: true, resolved: { name: 'acme', services: { web: {} } } })
        assert.deepEqual(calls[0]?.args, configArgv(project))
    })

    it('reports a failing compose config with its stderr', async () => {
        const { run } = runnerReturning({ exitCode: 1, stderr: 'yaml: line 3: mapping values are not allowed' })
        assert.deepEqual(await resolveCompose(project, run), {
            ok: false, problem: 'docker compose config failed: yaml: line 3: mapping values are not allowed',
        })
    })

    it('reports output that is not a compose configuration', async () => {
        for (const stdout of ['not json', '{"services":{}}', '{"name":"acme"}']) {
            const { run } = runnerReturning({ stdout })
            assert.deepEqual(await resolveCompose(project, run), { ok: false, problem: 'docker compose config returned unreadable output' }, stdout)
        }
    })

    it('reports a timeout', async () => {
        const { run } = runnerReturning({ exitCode: null, timedOut: true })
        assert.deepEqual(await resolveCompose(project, run), { ok: false, problem: 'docker compose config timed out' })
    })
})

describe('composeNameProblem', () => {
    it('says nothing when the names match', () => {
        assert.equal(composeNameProblem('acme', 'acme'), null)
    })

    it('names both the resolved name and the expected one when they differ', () => {
        assert.equal(
            composeNameProblem('acme-old', 'acme'),
            'compose resolves the project name acme-old, not acme; set name: acme in the compose file, or rename the registry entry',
        )
    })

    it('says nothing when the resolved name matches expected, even if it also equals collidesWith', () => {
        // Not a realistic case (expectedName and collidesWith are never equal in practice, since one is
        // always <id>-test and the other <id>), but proves the match check runs first regardless.
        assert.equal(composeNameProblem('acme', 'acme', 'acme'), null)
    })

    it('names the live-collision specifically when the resolved name is collidesWith rather than expected', () => {
        assert.equal(
            composeNameProblem('acme', 'acme-test', 'acme'),
            "compose resolves the project name acme, the same as the live environment; a test environment cannot share live's compose project name, since starting it would take over live's already-running containers instead of starting a separate stack. Set name: acme-test in the compose file, or rename the registry entry.",
        )
    })

    it('falls back to the ordinary message when the resolved name is neither expected nor collidesWith', () => {
        assert.equal(
            composeNameProblem('something-else', 'acme-test', 'acme'),
            'compose resolves the project name something-else, not acme-test; set name: acme-test in the compose file, or rename the registry entry',
        )
    })
})

describe('resolveNewProject', () => {
    const location = { dir: '/var/www/bakery', composePath: '/var/www/bakery/docker-compose.yml' }
    const resolving = (services: Record<string, { image?: string }>, name = 'bakery') => runnerReturning({ stdout: JSON.stringify({ name, services }) })

    it('marks a service with no recognisable database image as role site', async () => {
        const { run, calls } = resolving({ web: { image: 'acme/bakery-web:latest' }, worker: {} })
        assert.deepEqual(await resolveNewProject(location, 'bakery', run), {
            ok: true, services: { web: { role: 'site' }, worker: { role: 'site' } },
        })
        assert.deepEqual(calls[0]?.args, configArgv(location))
    })

    // A starting point the operator corrects, not a guarantee: every image string here is exactly the
    // kind of official Docker Hub name (repository only, or repository:tag, or behind a registry host and
    // port) this is meant to catch, not proof it catches every real database image in the wild.
    for (const [image, engine] of [
        ['postgres:16-alpine', 'postgres'],
        ['mariadb:11', 'mariadb'],
        ['mysql:8', 'mysql'],
        ['mongo:7', 'mongodb'],
        ['redis:7-alpine', 'redis'],
        ['registry.example.com:5000/library/postgres:16', 'postgres'],
    ] as const) {
        it(`guesses role database (${engine}) for image ${image}`, async () => {
            const { run } = resolving({ db: { image } })
            assert.deepEqual(await resolveNewProject(location, 'bakery', run), { ok: true, services: { db: { role: 'database', engine } } })
        })
    }

    it('is case-insensitive and matches the repository even with no tag', async () => {
        const { run } = resolving({ db: { image: 'Postgres' } })
        assert.deepEqual(await resolveNewProject(location, 'bakery', run), { ok: true, services: { db: { role: 'database', engine: 'postgres' } } })
    })

    // The match is a plain substring, exactly as specified (an image repository containing one of the
    // five names), so a repository whose name happens to contain one is guessed database too; this is
    // the false positive the "starting point, not a guarantee" comment on guessRole is about.
    it('matches a substring of a larger repository name, false positives included', async () => {
        const { run } = resolving({ web: { image: 'acme/postgresql-admin-web:latest' } })
        assert.deepEqual(await resolveNewProject(location, 'bakery', run), { ok: true, services: { web: { role: 'database', engine: 'postgres' } } })
    })

    it('reports no services at all rather than inventing one', async () => {
        const { run } = resolving({})
        assert.deepEqual(await resolveNewProject(location, 'bakery', run), { ok: true, services: {} })
    })

    it('passes a resolve failure through unchanged', async () => {
        const { run } = runnerReturning({ exitCode: 1, stderr: 'yaml: line 3: mapping values are not allowed' })
        assert.deepEqual(await resolveNewProject(location, 'bakery', run), {
            ok: false, problem: 'docker compose config failed: yaml: line 3: mapping values are not allowed',
        })
    })

    // Must-exist, per the whole-branch review: the spec's step 3 says the same guards run at creation, so
    // a repo whose compose file pins a mismatched name: must be refused here, before anything clones or
    // registers, not only later when guard.ts's ongoing sweep catches up to an already-registered project.
    it('refuses when the compose file resolves to a different project name than the one being created', async () => {
        const { run, calls } = resolving({ web: {} }, 'acme-old')
        assert.deepEqual(await resolveNewProject(location, 'bakery', run), {
            ok: false, problem: 'compose resolves the project name acme-old, not bakery; set name: bakery in the compose file, or rename the registry entry',
        })
        // The check runs on the resolved config compose already produced: it never triggers a second
        // command to find this out.
        assert.equal(calls.length, 1)
    })
})

// Regression coverage, per the whole-branch re-review: resolveNewProject's expectedName must be the
// environment's own folder basename, not the bare registry id. The tests above only ever use a
// live-shaped location (folder basename === id), which is exactly why this was missed the first time:
// comparing a test environment's resolved name against the bare id refused the ordinary, unpinned case
// for every repo, since an unpinned compose file resolves to the folder's own basename (<id>-test), not
// the project id.
describe('resolveNewProject for a test environment', () => {
    const location = { dir: '/var/www/acme-test', composePath: '/var/www/acme-test/docker-compose.yml' }
    const resolving = (name: string) => runnerReturning({ stdout: JSON.stringify({ name, services: { web: {} } }) })

    it('accepts a compose name matching the test folder, whether pinned or (the ordinary case) left to the default', async () => {
        const { run } = resolving('acme-test')
        assert.deepEqual(await resolveNewProject(location, 'acme-test', run, 'acme'), { ok: true, services: { web: { role: 'site' } } })
    })

    it('refuses, naming the collision, when the compose file pins the live environment\'s own name', async () => {
        const { run } = resolving('acme')
        assert.deepEqual(await resolveNewProject(location, 'acme-test', run, 'acme'), {
            ok: false,
            problem: "compose resolves the project name acme, the same as the live environment; a test environment cannot share live's compose project name, since starting it would take over live's already-running containers instead of starting a separate stack. Set name: acme-test in the compose file, or rename the registry entry.",
        })
    })

    it('refuses with the ordinary message when the compose file pins some unrelated name', async () => {
        const { run } = resolving('something-else')
        assert.deepEqual(await resolveNewProject(location, 'acme-test', run, 'acme'), {
            ok: false,
            problem: 'compose resolves the project name something-else, not acme-test; set name: acme-test in the compose file, or rename the registry entry',
        })
    })
})

type FakeChild = EventEmitter & { stdout: PassThrough, stderr: PassThrough, killedWith: string | null, kill(signal: string): boolean }

function fakeSpawn(behaviour: (child: FakeChild) => void) {
    const calls: Array<{ command: string, args: string[], options: Record<string, unknown> }> = []
    const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options })
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            killedWith: null as string | null,
            kill(signal: string) {
                child.killedWith = signal
                setImmediate(() => child.emit('close', null))
                return true
            },
        })
        setImmediate(() => behaviour(child))
        return child
    }) as unknown as typeof nodeSpawn
    return { spawn, calls }
}

describe('createSpawnRunner', () => {
    it('never uses a shell and captures stdout and the exit code', async () => {
        const { spawn, calls } = fakeSpawn(child => {
            child.stdout.once('end', () => child.emit('close', 0))
            child.stdout.end('hello')
        })
        const result = await createSpawnRunner(spawn)('docker', ['compose', 'ls'], 1000)
        assert.deepEqual(result, { exitCode: 0, stdout: 'hello', stderr: '', timedOut: false })
        assert.equal(calls[0]?.options.shell, false)
        assert.deepEqual(calls[0]?.args, ['compose', 'ls'])
    })

    // Compose interpolates ${VAR} from the environment into a project's compose file, and phase 2 puts
    // secrets (RESTIC_PASSWORD, R2 credentials) in this process's environment specifically to keep them
    // away from a compromised api. Only what docker itself needs may reach the child.
    it('passes docker only a minimal environment, never process.env wholesale', async () => {
        const original = { ...process.env }
        try {
            process.env.PATH = '/usr/bin'
            process.env.HOME = '/root'
            process.env.DOCKER_HOST = 'unix:///var/run/docker.sock'
            process.env.DOCKER_CONFIG = '/root/.docker'
            process.env.TZ = 'UTC'
            process.env.RESTIC_PASSWORD = 'super-secret'

            const { spawn, calls } = fakeSpawn(child => child.emit('close', 0))
            await createSpawnRunner(spawn)('docker', [], 1000)

            assert.deepEqual(calls[0]?.options.env, {
                PATH: '/usr/bin', HOME: '/root', DOCKER_HOST: 'unix:///var/run/docker.sock',
                DOCKER_CONFIG: '/root/.docker', TZ: 'UTC',
            })
        } finally {
            process.env = original
        }
    })

    it('omits an allowed key entirely when process.env does not set it', async () => {
        const original = { ...process.env }
        try {
            delete process.env.DOCKER_HOST
            delete process.env.DOCKER_CONFIG
            delete process.env.TZ
            process.env.PATH = '/usr/bin'
            process.env.HOME = '/root'

            const { spawn, calls } = fakeSpawn(child => child.emit('close', 0))
            await createSpawnRunner(spawn)('docker', [], 1000)

            assert.deepEqual(calls[0]?.options.env, { PATH: '/usr/bin', HOME: '/root' })
        } finally {
            process.env = original
        }
    })

    it('reports a spawn failure as a null exit code with the error', async () => {
        const { spawn } = fakeSpawn(child => child.emit('error', new Error('spawn docker ENOENT')))
        const result = await createSpawnRunner(spawn)('docker', [], 1000)
        assert.deepEqual(result, { exitCode: null, stdout: '', stderr: 'spawn docker ENOENT', timedOut: false })
    })

    it('kills a command that outlives its timeout', async () => {
        let spawned: FakeChild | null = null
        const { spawn } = fakeSpawn(child => { spawned = child })
        const result = await createSpawnRunner(spawn)('docker', [], 20)
        assert.equal(result.timedOut, true)
        assert.equal((spawned as FakeChild | null)?.killedWith, 'SIGKILL')
    })
})
