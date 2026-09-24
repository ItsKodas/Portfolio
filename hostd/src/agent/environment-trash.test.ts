import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { deleteEnvironment, restoreEnvironment, purgeDeleted, deletedEnvironments, type TrashDeps } from './environment-trash.ts'
import { DELETED_KEEP_MS, type DeletedRecord } from './deleted-store.ts'
import { RegistryWriter, environmentNodeIn, type RegistryWriteFs } from '../shared/registry-write.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'
import type { RunResult } from './compose.ts'

const REGISTRY_PATH = '/etc/hostd/projects.yaml'
const NOW = Date.parse('2026-09-24T10:00:00.000Z')
const UNIX = Math.floor(NOW / 1000)
const TRASH = `/var/www/acme/.deleted/uat1-${UNIX}`
const DAY = 24 * 60 * 60_000

const YAML = `projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [provision, domains]
    environments:
      live:
        dir: /var/www/acme/live
        branch: main
        domain: acme.com
        port: 5010
      uat1:
        dir: /var/www/acme/uat1
        branch: develop
        domain: uat1.acme.com
        aliases: [www.uat1.acme.com]
        port: 5020
        deployed: abc1234
  other:
    client: cl_2
    name: Other
    services:
      web: { role: site }
    environments:
      live:
        dir: /var/www/other
        domain: other.example.com
        port: 5011
`

type Options = {
    yaml?: string
    paths?: string[]
    // Which runner call fails, by its argv joined with spaces
    failRun?: (argv: string) => boolean
    failMove?: (from: string, to: string) => boolean
    failVhost?: 'remove' | 'put' | 'write'
    vhost?: string | null
    failRecord?: boolean
    records?: DeletedRecord[]
    takenPorts?: number[]
    hostUnreadable?: boolean
    volumes?: string[]
    realpath?: (path: string) => string
}

function setup(options: Options = {}) {
    const files = new Map([[REGISTRY_PATH, options.yaml ?? YAML]])
    const registryFs: RegistryWriteFs = {
        readFile: async path => files.get(path)!,
        stat: async () => ({ mode: 0o644, uid: 0, gid: 0 }),
        writeFile: async (path, text) => { files.set(path, text) },
        chmod: async () => {}, chown: async () => {},
        rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from) },
        unlink: async path => { files.delete(path) },
    }
    const writer = new RegistryWriter(REGISTRY_PATH, registryFs)
    const calls: string[] = []
    const runs: string[][] = []
    const paths = new Set(options.paths ?? ['/var/www/acme', '/var/www/acme/live', '/var/www/acme/uat1', '/var/www/acme/prev', '/var/www/acme/prev/uat1', '/var/www/acme/next'])
    const records: DeletedRecord[] = [...(options.records ?? [])]
    const envWrites: Array<{ dir: string, key: string, value: string }> = []
    let vhostText: string | null = options.vhost === undefined ? 'the vhost acme-uat1.conf' : options.vhost
    const removed: string[] = []

    const deps: TrashDeps = {
        registry: () => parseRegistry(files.get(REGISTRY_PATH)!),
        refreshRegistry: async () => {},
        writer: {
            write: async change => {
                const result = await writer.write(change)
                calls.push(`registry ${change.kind}${result.ok ? '' : ' refused'}`)
                return result
            },
            environmentNode: (id, environment) => writer.environmentNode(id, environment),
        },
        store: {
            list: project => records.filter(entry => project === undefined || entry.project === project),
            add: async record => {
                if (options.failRecord) throw new Error('ENOSPC: no space left on device')
                calls.push(`record add ${record.environment}`)
                records.push(record)
            },
            update: async record => {
                calls.push(`record update ${record.environment}`)
                const at = records.findIndex(entry => entry.project === record.project && entry.environment === record.environment && entry.deletedAt === record.deletedAt)
                if (at !== -1) records[at] = record
            },
            remove: async (project, environment, deletedAt) => {
                calls.push(`record remove ${environment}`)
                const at = records.findIndex(entry => entry.project === project && entry.environment === environment && entry.deletedAt === deletedAt)
                if (at !== -1) records.splice(at, 1)
            },
        },
        fs: {
            exists: async path => paths.has(path),
            mkdir: async dir => { calls.push(`mkdir ${dir}`); paths.add(dir) },
            move: async (from, to) => {
                if (options.failMove?.(from, to)) throw new Error(`EXDEV: cannot move ${from}`)
                if (!paths.has(from)) throw new Error(`ENOENT: ${from}`)
                calls.push(`move ${from} -> ${to}`)
                for (const path of [...paths]) {
                    if (path === from || path.startsWith(`${from}/`)) {
                        paths.delete(path)
                        paths.add(to + path.slice(from.length))
                    }
                }
            },
            rmdir: async dir => {
                calls.push(`rmdir ${dir}`)
                removed.push(dir)
                for (const path of [...paths]) if (path === dir || path.startsWith(`${dir}/`)) paths.delete(path)
            },
            removeEmptyDir: async dir => {
                if ([...paths].some(path => path.startsWith(`${dir}/`))) throw new Error(`ENOTEMPTY: ${dir}`)
                calls.push(`rmdir-empty ${dir}`)
                paths.delete(dir)
            },
            owner: async () => ({ uid: 1000, gid: 1000, mode: 0o775 }),
            own: async dir => { calls.push(`own ${dir}`) },
            realpath: async path => (options.realpath ? options.realpath(path) : path),
        },
        runner: async (command, args) => {
            runs.push([command, ...args])
            const argv = args.join(' ')
            const verb = args.includes('down') ? 'down' : args.includes('up') ? 'up' : args.slice(0, 2).join(' ')
            calls.push(`${command} ${verb}`)
            const failed = options.failRun?.(argv) ?? false
            const stdout = args[1] === 'ls' ? (options.volumes ?? []).join('\n') : ''
            return { exitCode: failed ? 1 : 0, stdout, stderr: failed ? 'no such thing' : '', timedOut: false } satisfies RunResult
        },
        vhosts: {
            read: async () => vhostText,
            remove: async () => {
                if (options.failVhost === 'remove') return { ok: false, message: 'Apache refused' }
                calls.push('vhost remove')
                vhostText = null
                return { ok: true }
            },
            put: async (_project, _environment, text) => {
                if (options.failVhost === 'put') return { ok: false, message: 'Apache refused the old file too' }
                calls.push('vhost put')
                vhostText = text
                return { ok: true }
            },
            write: async (_project, environment, token) => {
                if (options.failVhost === 'write') return { ok: false, message: 'Apache refused' }
                calls.push(`vhost write ${environment.domain} ${token}`)
                return { ok: true }
            },
        },
        checkPort: async port => {
            if (options.hostUnreadable) return { ok: false, code: 'unavailable', problem: 'ss could not be read' }
            return (options.takenPorts ?? []).includes(port) ? { ok: false, code: 'bad-request', problem: `port ${port} is taken` } : { ok: true }
        },
        choosePort: async () => ({ ok: true, port: 5030 }),
        setPortEnv: async (environment, key, port) => {
            calls.push(`port env ${port}`)
            envWrites.push({ dir: environment.dir, key, value: String(port) })
            return { ok: true, previous: 'WEB_PORT=5020\n' }
        },
        restorePortEnv: async (environment, previous) => {
            calls.push('port env restored')
            envWrites.push({ dir: environment.dir, key: 'restore', value: previous ?? '' })
            return { ok: true }
        },
        portOverride: async location => {
            calls.push(`port override ${location.dir}`)
            return { ok: true, composePaths: [...location.composePaths], service: 'web', target: 3000 }
        },
        now: () => NOW,
        log: () => {},
    }
    const registry = () => parseRegistry(files.get(REGISTRY_PATH)!)
    const project = (): ProjectEntry => registry().projects.get('acme')!
    return { deps, calls, runs, paths, records, envWrites, removed, registry, project, vhost: () => vhostText }
}

// What a delete of uat1 leaves in the record, for the restore and purge tests to start from
function deletedRecord(overrides: Partial<DeletedRecord> = {}): DeletedRecord {
    return {
        project: 'acme', environment: 'uat1', deletedAt: new Date(NOW - DAY).toISOString(), trash: TRASH, composeName: 'acme-uat1',
        node: environmentNodeIn(YAML, 'acme', 'uat1')!, actor: 'koda', ...overrides,
    }
}

const WITHOUT_UAT1 = YAML.replace(/      uat1:\n(?:        .*\n)+/, '')
const TRASHED = ['/var/www/acme', '/var/www/acme/live', '/var/www/acme/prev', '/var/www/acme/next', '/var/www/acme/.deleted', TRASH, `${TRASH}/tree`, `${TRASH}/prev`]

describe('deleteEnvironment', () => {
    it('stops uat1, takes it off the web, moves it into the trash, records it, then unregisters it', async () => {
        const { deps, calls, runs, paths, records, registry, project } = setup()
        const reply = await deleteEnvironment(project(), 'uat1', 'koda', deps)
        assert.equal(reply.ok, true, JSON.stringify(reply))

        assert.deepEqual(calls, [
            'docker down',
            'vhost remove',
            'mkdir /var/www/acme/.deleted', 'own /var/www/acme/.deleted',
            `mkdir ${TRASH}`, `own ${TRASH}`,
            `move /var/www/acme/uat1 -> ${TRASH}/tree`,
            `move /var/www/acme/prev/uat1 -> ${TRASH}/prev`,
            'record add uat1',
            'registry remove-environment',
        ])
        // Under its own compose name, at its own folder, and never with -v
        assert.deepEqual(runs[0], [
            'docker', 'compose', '--project-name', 'acme-uat1', '--project-directory', '/var/www/acme/uat1',
            '-f', '/var/www/acme/uat1/docker-compose.yml', 'down', '--remove-orphans',
        ])
        assert.ok(runs.every(run => !run.includes('-v') && !run.includes('--volumes')))
        assert.equal(paths.has('/var/www/acme/uat1'), false)
        assert.equal(paths.has(`${TRASH}/tree`), true)

        assert.equal(records.length, 1)
        assert.deepEqual(records[0], {
            project: 'acme', environment: 'uat1', deletedAt: '2026-09-24T10:00:00.000Z', trash: TRASH, composeName: 'acme-uat1',
            node: environmentNodeIn(YAML, 'acme', 'uat1'), actor: 'koda',
        })
        assert.equal(registry().projects.get('acme')!.environments.has('uat1'), false)
    })

    it('moves next too when it is there, and makes no .deleted folder that already exists', async () => {
        const { deps, calls, project } = setup({
            paths: ['/var/www/acme', '/var/www/acme/uat1', '/var/www/acme/next/uat1', '/var/www/acme/.deleted'],
        })
        const reply = await deleteEnvironment(project(), 'uat1', 'koda', deps)
        assert.equal(reply.ok, true)
        assert.ok(!calls.includes('mkdir /var/www/acme/.deleted'))
        assert.ok(calls.includes(`move /var/www/acme/next/uat1 -> ${TRASH}/next`))
        assert.ok(!calls.some(call => call.startsWith('move /var/www/acme/prev')))
    })

    it('leaves the vhost alone when hostd never wrote one', async () => {
        const { deps, calls, project } = setup({ vhost: null })
        assert.equal((await deleteEnvironment(project(), 'uat1', 'koda', deps)).ok, true)
        assert.ok(!calls.includes('vhost remove'))
    })

    it('refuses live, and a name the project does not have, touching nothing', async () => {
        const { deps, calls, project } = setup()
        const live = await deleteEnvironment(project(), 'live', 'koda', deps)
        assert.equal(live.ok === false && live.code, 'bad-request')
        const missing = await deleteEnvironment(project(), 'uat2', 'koda', deps)
        assert.equal(missing.ok === false && missing.code, 'unknown-environment')
        assert.deepEqual(calls, [])
    })

    it('refuses when compose down fails, having changed nothing', async () => {
        const { deps, calls, records, registry, project } = setup({ failRun: argv => argv.includes('down') })
        const reply = await deleteEnvironment(project(), 'uat1', 'koda', deps)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.deepEqual(calls, ['docker down'])
        assert.equal(records.length, 0)
        assert.equal(registry().projects.get('acme')!.environments.has('uat1'), true)
    })

    it('undoes in reverse when a move fails: moves back, rewrites the vhost, starts it again, no record, registry unchanged', async () => {
        const { deps, calls, paths, records, registry, project, vhost } = setup({ failMove: from => from === '/var/www/acme/prev/uat1' })
        const reply = await deleteEnvironment(project(), 'uat1', 'koda', deps)
        assert.equal(reply.ok === false && reply.code, 'failed')
        assert.match(reply.ok === false ? reply.message : '', /EXDEV/)

        const undo = calls.slice(calls.indexOf(`move /var/www/acme/uat1 -> ${TRASH}/tree`) + 1)
        assert.deepEqual(undo, [
            `move ${TRASH}/tree -> /var/www/acme/uat1`,
            `rmdir-empty ${TRASH}`,
            'rmdir-empty /var/www/acme/.deleted',
            'vhost put',
            'docker up',
        ])
        assert.equal(paths.has('/var/www/acme/uat1'), true)
        assert.equal(paths.has('/var/www/acme/prev/uat1'), true)
        assert.equal(vhost(), 'the vhost acme-uat1.conf')
        assert.equal(records.length, 0)
        assert.equal(registry().projects.get('acme')!.environments.has('uat1'), true)
    })

    it('undoes the moves and the record when the registry write fails', async () => {
        const yaml = YAML
        const { deps, calls, records, paths, project } = setup({ yaml })
        deps.writer = { ...deps.writer, write: async () => { calls.push('registry refused'); return { ok: false, problem: 'the registry could not be written' } } }
        const reply = await deleteEnvironment(project(), 'uat1', 'koda', deps)
        assert.equal(reply.ok, false)
        assert.equal(records.length, 0)
        assert.ok(calls.includes('record remove uat1'))
        assert.equal(paths.has('/var/www/acme/uat1'), true)
        assert.equal(paths.has('/var/www/acme/prev/uat1'), true)
        assert.equal(calls.at(-1), 'docker up')
    })

    it('undoes when the record cannot be written', async () => {
        const { deps, paths, registry, project } = setup({ failRecord: true })
        const reply = await deleteEnvironment(project(), 'uat1', 'koda', deps)
        assert.equal(reply.ok, false)
        assert.equal(paths.has('/var/www/acme/uat1'), true)
        assert.equal(registry().projects.get('acme')!.environments.has('uat1'), true)
    })

    // An undo that cannot finish stops where it is and says so, rather than carrying on over a state it
    // no longer understands, and it never deletes anything to get out of one.
    it('stops an undo that cannot finish, says what is left, and deletes nothing', async () => {
        const { deps, calls, removed, project } = setup({
            failMove: (from, to) => from === '/var/www/acme/prev/uat1' || to === '/var/www/acme/uat1',
        })
        const reply = await deleteEnvironment(project(), 'uat1', 'koda', deps)
        assert.equal(reply.ok === false && reply.code, 'failed')
        const message = reply.ok === false ? reply.message : ''
        assert.match(message, /undo stopped/)
        assert.match(message, new RegExp(`${TRASH}/tree`))
        assert.deepEqual(removed, [])
        assert.ok(!calls.includes('vhost put'))
        assert.ok(!calls.includes('docker up'))
    })

    it('refuses when the vhost cannot be removed, and starts the environment again', async () => {
        const { deps, calls, paths, project } = setup({ failVhost: 'remove' })
        const reply = await deleteEnvironment(project(), 'uat1', 'koda', deps)
        assert.equal(reply.ok, false)
        assert.deepEqual(calls, ['docker down', 'docker up'])
        assert.equal(paths.has('/var/www/acme/uat1'), true)
    })
})

describe('restoreEnvironment', () => {
    it('keeps the port and every hostname when they are still free, and moves everything back', async () => {
        const { deps, calls, paths, records, registry, project } = setup({ yaml: WITHOUT_UAT1, paths: TRASHED, records: [deletedRecord()] })
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, 'abc123', deps)
        assert.deepEqual(reply, { ok: true, port: 5020, portChanged: false, droppedHostnames: [], warnings: [], vhost: true })

        assert.equal(paths.has('/var/www/acme/uat1'), true)
        assert.equal(paths.has('/var/www/acme/prev/uat1'), true)
        assert.equal(paths.has(TRASH), false)
        const uat1 = registry().projects.get('acme')!.environments.get('uat1')!
        assert.equal(uat1.port, 5020)
        assert.equal(uat1.domain, 'uat1.acme.com')
        assert.deepEqual(uat1.aliases, ['www.uat1.acme.com'])
        assert.equal(uat1.deployed, 'abc1234')
        assert.equal(records.length, 0)
        assert.ok(!calls.some(call => call.startsWith('port env')))
        assert.deepEqual(calls.slice(-5), ['registry restore-environment', 'vhost write uat1.acme.com abc123', 'docker up', 'record remove uat1', `rmdir-empty ${TRASH}`])
    })

    it('chooses another port when the recorded one was taken, and rewrites .env and hostd.ports.yml for it', async () => {
        const { deps, calls, envWrites, registry, project } = setup({ yaml: WITHOUT_UAT1, paths: TRASHED, records: [deletedRecord()], takenPorts: [5020] })
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, 'abc123', deps)
        assert.equal(reply.ok, true)
        assert.equal(reply.ok && 'portChanged' in reply && reply.portChanged, true)
        assert.equal(reply.ok && 'port' in reply && reply.port, 5030)
        assert.deepEqual(envWrites, [{ dir: '/var/www/acme/uat1', key: 'WEB_PORT', value: '5030' }])
        assert.ok(calls.indexOf('port override /var/www/acme/uat1') < calls.indexOf('registry restore-environment'))
        assert.ok(calls.indexOf(`move ${TRASH}/tree -> /var/www/acme/uat1`) < calls.indexOf('port env 5030'))
        assert.equal(registry().projects.get('acme')!.environments.get('uat1')!.port, 5030)
    })

    it('drops a hostname another project claimed meanwhile and says so', async () => {
        const yaml = WITHOUT_UAT1.replace('        domain: other.example.com\n', '        domain: other.example.com\n        aliases: [www.uat1.acme.com]\n')
        const { deps, registry, project } = setup({ yaml, paths: TRASHED, records: [deletedRecord()] })
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, 'abc123', deps)
        assert.equal(reply.ok, true, JSON.stringify(reply))
        assert.deepEqual(reply.ok && 'droppedHostnames' in reply && reply.droppedHostnames, ['www.uat1.acme.com'])
        const uat1 = registry().projects.get('acme')!.environments.get('uat1')!
        assert.equal(uat1.domain, 'uat1.acme.com')
        assert.deepEqual(uat1.aliases, [])
    })

    it('promotes the first free alias when the primary was taken', async () => {
        const yaml = WITHOUT_UAT1.replace('        domain: other.example.com\n', '        domain: other.example.com\n        aliases: [uat1.acme.com]\n')
        const { deps, calls, registry, project } = setup({ yaml, paths: TRASHED, records: [deletedRecord()] })
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, 'abc123', deps)
        assert.equal(reply.ok, true, JSON.stringify(reply))
        assert.deepEqual(reply.ok && 'droppedHostnames' in reply && reply.droppedHostnames, ['uat1.acme.com'])
        const uat1 = registry().projects.get('acme')!.environments.get('uat1')!
        assert.equal(uat1.domain, 'www.uat1.acme.com')
        assert.deepEqual(uat1.aliases, [])
        assert.ok(calls.includes('vhost write www.uat1.acme.com abc123'))
    })

    it('refuses when the project has the name again', async () => {
        const { deps, calls, records, project } = setup({ paths: TRASHED, records: [deletedRecord()] })
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, 'abc123', deps)
        assert.equal(reply.ok === false && reply.code, 'bad-request')
        assert.match(reply.ok === false ? reply.message : '', /already has a uat1/)
        assert.deepEqual(calls, [])
        assert.equal(records.length, 1)
    })

    it('refuses a record past its 30 days', async () => {
        const old = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString() })
        const { deps, calls, project } = setup({ yaml: WITHOUT_UAT1, paths: TRASHED, records: [old] })
        const reply = await restoreEnvironment(project(), 'uat1', old.deletedAt, 'abc123', deps)
        assert.equal(reply.ok === false && reply.code, 'bad-request')
        assert.match(reply.ok === false ? reply.message : '', /30 days/)
        assert.deepEqual(calls, [])
    })

    it('refuses when the trash folder is gone', async () => {
        const { deps, calls, project } = setup({ yaml: WITHOUT_UAT1, paths: ['/var/www/acme', '/var/www/acme/live'], records: [deletedRecord()] })
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, 'abc123', deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok === false ? reply.message : '', /is gone/)
        assert.deepEqual(calls, [])
    })

    it('refuses a record it does not have', async () => {
        const { deps, project } = setup({ yaml: WITHOUT_UAT1, paths: TRASHED, records: [deletedRecord()] })
        const reply = await restoreEnvironment(project(), 'uat1', '2026-01-01T00:00:00.000Z', 'abc123', deps)
        assert.equal(reply.ok === false && reply.code, 'bad-request')
    })

    it('moves everything back into the trash and keeps the record when the registry write fails', async () => {
        const { deps, paths, records, envWrites, project } = setup({ yaml: WITHOUT_UAT1, paths: TRASHED, records: [deletedRecord()], takenPorts: [5020] })
        deps.writer = { ...deps.writer, write: async () => ({ ok: false, problem: 'the registry could not be written' }) }
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, 'abc123', deps)
        assert.equal(reply.ok, false)
        assert.equal(paths.has(`${TRASH}/tree`), true)
        assert.equal(paths.has(`${TRASH}/prev`), true)
        assert.equal(paths.has('/var/www/acme/uat1'), false)
        assert.equal(records.length, 1)
        assert.deepEqual(envWrites.at(-1), { dir: '/var/www/acme/uat1', key: 'restore', value: 'WEB_PORT=5020\n' })
    })

    it('writes no vhost without a token, and says so', async () => {
        const { deps, calls, project } = setup({ yaml: WITHOUT_UAT1, paths: TRASHED, records: [deletedRecord()] })
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, null, deps)
        assert.equal(reply.ok && 'vhost' in reply && reply.vhost, false)
        assert.ok(!calls.some(call => call.startsWith('vhost write')))
    })

    // What stayed behind is still the purge's to remove, so the record is slimmed to just that rather than
    // dropped, which would leave the folder behind for ever
    it('keeps a record of what it had to leave in the trash, for the purge', async () => {
        const paths = TRASHED.filter(path => path !== '/var/www/acme/prev').concat(['/var/www/acme/next', `${TRASH}/next`])
        const { deps, records, project } = setup({ yaml: WITHOUT_UAT1, paths, records: [deletedRecord()] })
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, 'abc123', deps)
        assert.equal(reply.ok, true)
        assert.equal(reply.ok && 'warnings' in reply && reply.warnings.length, 1)
        assert.deepEqual(records, [{ ...deletedRecord(), leftovers: true }])
    })

    it('reports a start that failed after the environment was back, rather than undoing it', async () => {
        const { deps, records, registry, project } = setup({ yaml: WITHOUT_UAT1, paths: TRASHED, records: [deletedRecord()], failRun: argv => argv.includes(' up ') })
        const reply = await restoreEnvironment(project(), 'uat1', deletedRecord().deletedAt, 'abc123', deps)
        assert.equal(reply.ok, true)
        assert.equal(reply.ok && 'warnings' in reply && reply.warnings.length, 1)
        assert.equal(registry().projects.get('acme')!.environments.has('uat1'), true)
        assert.equal(records.length, 0)
    })
})

describe('purgeDeleted', () => {
    it('purges only records older than 30 days: the trash folder, then the volumes of the recorded compose name', async () => {
        const old = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString() })
        const recent = deletedRecord({ environment: 'uat2', composeName: 'acme-uat2', trash: `/var/www/acme/.deleted/uat2-${UNIX}` })
        const { deps, runs, removed, records } = setup({ yaml: WITHOUT_UAT1, records: [old, recent], volumes: ['acme-uat1_db', 'acme-uat1_media'] })
        const result = await purgeDeleted(NOW, deps)
        assert.deepEqual(result.purged, ['acme uat1'])
        assert.deepEqual(removed, [TRASH])
        assert.deepEqual(runs, [
            ['docker', 'volume', 'ls', '--filter', 'label=com.docker.compose.project=acme-uat1', '-q'],
            ['docker', 'volume', 'rm', 'acme-uat1_db'],
            ['docker', 'volume', 'rm', 'acme-uat1_media'],
        ])
        assert.deepEqual(records, [recent])
    })

    it('refuses a record whose compose name a registered environment uses, and keeps it', async () => {
        const old = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString() })
        const { deps, runs, removed, records } = setup({ records: [old], volumes: ['acme-uat1_db'] })
        const result = await purgeDeleted(NOW, deps)
        assert.deepEqual(result.purged, [])
        assert.deepEqual(result.kept, ['acme uat1'])
        assert.deepEqual(runs, [])
        assert.deepEqual(removed, [])
        assert.equal(records.length, 1)
    })

    it('keeps the record when a volume cannot be removed, for the next sweep', async () => {
        const old = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString() })
        const { deps, records } = setup({ yaml: WITHOUT_UAT1, records: [old], volumes: ['acme-uat1_db'], failRun: argv => argv.startsWith('volume rm') })
        const result = await purgeDeleted(NOW, deps)
        assert.deepEqual(result.kept, ['acme uat1'])
        assert.equal(records.length, 1)
    })

    it('purges leftovers of a restore without touching the volumes the restored environment uses', async () => {
        const leftovers = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString(), leftovers: true })
        const { deps, runs, removed, records } = setup({ records: [leftovers], volumes: ['acme-uat1_db'] })
        const result = await purgeDeleted(NOW, deps)
        assert.deepEqual(result.purged, ['acme uat1'])
        assert.deepEqual(removed, [TRASH])
        assert.deepEqual(runs, [])
        assert.equal(records.length, 0)
    })

    // A restore that finished between the listing and this record, or one still running, must win
    it('re-reads the registry and the record just before deleting anything', async () => {
        const old = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString() })
        const { deps, removed, runs, records } = setup({ yaml: WITHOUT_UAT1, records: [old], volumes: ['acme-uat1_db'] })
        let refreshed = 0
        deps.refreshRegistry = async () => {
            refreshed += 1
            records.splice(0, records.length)
        }
        const result = await purgeDeleted(NOW, deps)
        assert.ok(refreshed >= 1)
        assert.deepEqual(result.purged, [])
        assert.deepEqual(removed, [])
        assert.deepEqual(runs, [])
    })

    it('skips a record the caller says is busy', async () => {
        const old = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString() })
        const { deps, removed, runs, records } = setup({ yaml: WITHOUT_UAT1, records: [old], volumes: ['acme-uat1_db'] })
        const result = await purgeDeleted(NOW, { ...deps, busy: record => record.environment === 'uat1' })
        assert.deepEqual(result.kept, ['acme uat1'])
        assert.deepEqual(removed, [])
        assert.deepEqual(runs, [])
        assert.equal(records.length, 1)
    })

    // An invalid project drops out of registry.projects, and with it the protection for its compose names
    it('removes no volumes, and no trash, while any project in the registry is invalid', async () => {
        const old = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString() })
        const yaml = `${WITHOUT_UAT1}  broken:\n    client: cl_9\n`
        const { deps, removed, runs, records, registry } = setup({ yaml, records: [old], volumes: ['acme-uat1_db'] })
        assert.equal(registry().invalid.has('broken'), true)
        const result = await purgeDeleted(NOW, deps)
        assert.deepEqual(result.kept, ['acme uat1'])
        assert.deepEqual(removed, [])
        assert.deepEqual(runs, [])
        assert.equal(records.length, 1)
    })

    it('skips a trash folder whose real path is not the recorded one', async () => {
        const old = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString() })
        const { deps, removed, runs, records } = setup({ yaml: WITHOUT_UAT1, records: [old], realpath: path => path.replace('/var/www/acme', '/srv/elsewhere') })
        const result = await purgeDeleted(NOW, deps)
        assert.deepEqual(result.kept, ['acme uat1'])
        assert.deepEqual(removed, [])
        assert.deepEqual(runs, [])
        assert.equal(records.length, 1)
    })

    it('forgets the environment\'s deploy history once it is purged', async () => {
        const old = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString() })
        const { deps } = setup({ yaml: WITHOUT_UAT1, records: [old] })
        const forgotten: string[] = []
        await purgeDeleted(NOW, { ...deps, forgetDeploys: async key => { forgotten.push(key) } })
        assert.deepEqual(forgotten, ['acme:uat1'])
    })

    it('never deletes a path outside a site\'s .deleted folder', async () => {
        const stray = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString(), trash: '/var/www/acme/uat1' })
        const dotted = deletedRecord({ deletedAt: new Date(NOW - DELETED_KEEP_MS - 1000).toISOString(), trash: '/var/www/acme/.deleted/../live' })
        const { deps, removed, runs, records } = setup({ yaml: WITHOUT_UAT1, records: [stray, dotted] })
        await purgeDeleted(NOW, deps)
        assert.deepEqual(removed, [])
        assert.deepEqual(runs, [])
        assert.equal(records.length, 2)
    })
})

describe('deletedEnvironments', () => {
    it('lists a project\'s deleted environments with when each is purged', () => {
        const { deps } = setup({ records: [deletedRecord(), deletedRecord({ project: 'other' }), deletedRecord({ deletedAt: new Date(NOW).toISOString(), leftovers: true })] })
        assert.deepEqual(deletedEnvironments('acme', deps), [{
            environment: 'uat1', deletedAt: deletedRecord().deletedAt,
            purgeAt: new Date(NOW - DAY + DELETED_KEEP_MS).toISOString(),
            branch: 'develop', domain: 'uat1.acme.com', aliases: ['www.uat1.acme.com'],
        }])
    })
})
