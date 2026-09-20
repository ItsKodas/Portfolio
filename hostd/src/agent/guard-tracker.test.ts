import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GuardTracker } from './guard-tracker.ts'
import type { Runner } from './compose.ts'
import { parseRegistry } from '../shared/registry.ts'

const text = (ids: string[]) => `projects:\n${ids.map(id => `  ${id}:
    client: cl_1
    name: ${id}
    dir: /var/www/${id}
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
    storage: { media: { path: uploads, mode: rw } }
`).join('')}`

// compose config as Docker would resolve it for each project, keyed by project directory.
function composeRunner(configs: Record<string, unknown>): Runner {
    return async (_command, args) => {
        const dir = args[args.indexOf('--project-directory') + 1] ?? ''
        const config = configs[dir]
        if (config === undefined) return { exitCode: 1, stdout: '', stderr: 'no configuration file provided: not found', timedOut: false }
        return { exitCode: 0, stdout: JSON.stringify(config), stderr: '', timedOut: false }
    }
}

const goodConfig = (id: string) => ({ name: id, services: { web: { volumes: [{ type: 'bind', source: `/var/www/${id}/uploads` }] } } })

// Stands in for a real disk: every storage root is a real directory unless told otherwise.
const storageOk = async () => 'ok' as const

describe('GuardTracker', () => {
    it('records nothing for projects that pass', async () => {
        const registry = parseRegistry(text(['alpha']))
        const tracker = new GuardTracker(composeRunner({ '/var/www/alpha': goodConfig('alpha') }), async () => true, storageOk)
        await tracker.checkAll(registry)
        assert.deepEqual(tracker.current(), new Map())
        assert.deepEqual(tracker.warnings(), [])
    })

    it('marks a project whose directory is missing', async () => {
        const registry = parseRegistry(text(['alpha']))
        const tracker = new GuardTracker(composeRunner({}), async () => false, storageOk)
        await tracker.checkAll(registry)
        assert.equal(tracker.current().get('alpha'), '/var/www/alpha does not exist on the dedi')
    })

    it('marks a project whose compose config fails, and one the guard rejects', async () => {
        const registry = parseRegistry(text(['alpha', 'bravo']))
        const tracker = new GuardTracker(composeRunner({
            '/var/www/bravo': { name: 'bravo', services: { web: { volumes: [] } } },
        }), async () => true, storageOk)
        await tracker.checkAll(registry)
        assert.match(tracker.current().get('alpha') ?? '', /^docker compose config failed: no configuration file provided/)
        assert.equal(tracker.current().get('bravo'), 'storage media (/var/www/bravo/uploads) is not bind-mounted into a site service')
        assert.deepEqual(tracker.warnings(), [
            `project alpha is invalid: ${tracker.current().get('alpha')}`,
            'project bravo is invalid: storage media (/var/www/bravo/uploads) is not bind-mounted into a site service',
        ])
    })

    it('clears a project once it passes again, and returns the verdict from check()', async () => {
        const registry = parseRegistry(text(['alpha']))
        const configs: Record<string, unknown> = {}
        const tracker = new GuardTracker(composeRunner(configs), async () => true, storageOk)
        await tracker.checkAll(registry)
        assert.ok(tracker.current().has('alpha'))
        configs['/var/www/alpha'] = goodConfig('alpha')
        assert.equal(await tracker.check(registry.projects.get('alpha')!), null)
        assert.equal(tracker.current().has('alpha'), false)
    })

    it('forgets projects that have left the registry', async () => {
        const tracker = new GuardTracker(composeRunner({}), async () => true, storageOk)
        await tracker.checkAll(parseRegistry(text(['alpha'])))
        assert.ok(tracker.current().has('alpha'))
        // An empty mapping, not text([]): "projects:" with nothing under it is YAML null, a whole-file error.
        await tracker.checkAll(parseRegistry('projects: {}\n'))
        assert.deepEqual(tracker.current(), new Map())
    })

    it('marks a project invalid, without throwing, when the guard itself hits a shape it cannot handle', async () => {
        const registry = parseRegistry(text(['alpha', 'bravo']))
        const tracker = new GuardTracker(composeRunner({
            '/var/www/alpha': { name: 'alpha', services: { web: { volumes: 'not-a-list' } } },
            '/var/www/bravo': goodConfig('bravo'),
        }), async () => true, storageOk)
        await assert.doesNotReject(tracker.checkAll(registry))
        assert.match(tracker.current().get('alpha') ?? '', /^the storage guard could not check this project:/)
        assert.equal(tracker.current().has('bravo'), false)
    })

    it('marks a project whose storage root does not exist on disk', async () => {
        const registry = parseRegistry(text(['alpha']))
        const tracker = new GuardTracker(
            composeRunner({ '/var/www/alpha': goodConfig('alpha') }),
            async () => true,
            async () => 'missing',
        )
        await tracker.checkAll(registry)
        assert.equal(tracker.current().get('alpha'), 'storage media (/var/www/alpha/uploads) does not exist')
    })

    it('re-checks only the projects that are currently invalid', async () => {
        const registry = parseRegistry(text(['alpha', 'bravo']))
        const configs: Record<string, unknown> = { '/var/www/bravo': goodConfig('bravo') }
        const checked: string[] = []
        const runner = composeRunner(configs)
        const tracker = new GuardTracker(async (command, args, timeoutMs) => {
            checked.push(args[args.indexOf('--project-directory') + 1] ?? '')
            return runner(command, args, timeoutMs)
        }, async () => true, storageOk)
        await tracker.checkAll(registry)
        assert.ok(tracker.current().has('alpha'))

        // The operator has fixed alpha. bravo was already fine, so re-checking it would only spend a
        // docker compose config run to learn nothing.
        configs['/var/www/alpha'] = goodConfig('alpha')
        checked.length = 0
        await tracker.recheckInvalid(registry)
        assert.deepEqual(tracker.current(), new Map())
        assert.deepEqual(checked, ['/var/www/alpha'])
    })

    it('keeps a project that is still invalid marked, with its current reason', async () => {
        const registry = parseRegistry(text(['alpha']))
        const dirs = new Set<string>()
        const tracker = new GuardTracker(composeRunner({}), async path => dirs.has(path), storageOk)
        await tracker.checkAll(registry)
        assert.equal(tracker.current().get('alpha'), '/var/www/alpha does not exist on the dedi')

        // The directory now exists but its compose file still does not, so the project stays invalid and
        // the reason moves on to what is actually wrong now.
        dirs.add('/var/www/alpha')
        await tracker.recheckInvalid(registry)
        assert.match(tracker.current().get('alpha') ?? '', /^docker compose config failed: no configuration file provided/)
    })

    it('forgets projects that have left the registry when re-checking the invalid ones', async () => {
        const tracker = new GuardTracker(composeRunner({}), async () => true, storageOk)
        await tracker.checkAll(parseRegistry(text(['alpha'])))
        assert.ok(tracker.current().has('alpha'))
        await tracker.recheckInvalid(parseRegistry('projects: {}\n'))
        assert.deepEqual(tracker.current(), new Map())
    })

    it('marks a project whose storage root is a symlink rather than a real directory', async () => {
        const registry = parseRegistry(text(['alpha']))
        const tracker = new GuardTracker(
            composeRunner({ '/var/www/alpha': goodConfig('alpha') }),
            async () => true,
            async () => 'not-a-directory',
        )
        await tracker.checkAll(registry)
        assert.equal(tracker.current().get('alpha'), 'storage media (/var/www/alpha/uploads) is not a directory')
    })
})
