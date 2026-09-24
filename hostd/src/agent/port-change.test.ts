import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { changePort, type PortChangeDeps } from './port-change.ts'
import { notPublishedProblem } from './provision.ts'
import { parseRegistry } from '../shared/registry.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:a/acme.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010, domain: acme.com }
`)
const acme = registry.projects.get('acme')!

// The same project with no address, and one whose live environment answers only to aliases
const bare = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:a/acme.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010 }
`).projects.get('acme')!

// A site created (or moved) since hostd.ports.yml: the override already names ${WEB_PORT}, so a move only
// rewrites .env
const withOverride = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:a/acme.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010, compose: [docker-compose.yml, hostd.ports.yml] }
`).projects.get('acme')!

function fakes(overrides: Partial<PortChangeDeps> = {}) {
    const steps: string[] = []
    const deps: PortChangeDeps = {
        checkPort: async port => { steps.push(`check ${port}`); return { ok: true } },
        setPortEnv: async (_env, key, port) => { steps.push(`env ${key}=${port}`); return { ok: true, previous: 'WEB_PORT=5010\n' } },
        restorePortEnv: async (_env, previous) => { steps.push(`restore env ${JSON.stringify(previous)}`); return { ok: true } },
        override: async env => {
            steps.push('override')
            return { ok: true, composePaths: [...env.composePaths, `${env.dir}/hostd.ports.yml`], service: 'web', target: 3000 }
        },
        removeOverride: async () => { steps.push('remove override') },
        published: async () => { steps.push('published'); return { ok: true, ports: [5012] } },
        writePort: async (port, compose) => { steps.push(compose ? `registry ${port} ${compose.join(',')}` : `registry ${port}`); return { ok: true } },
        running: async () => { steps.push('running?'); return true },
        up: async () => { steps.push('up'); return { ok: true } },
        rewriteVhost: async () => { steps.push('vhost'); return null },
        hasOwnVhost: async () => true,
        ...overrides,
    }
    return { deps, steps }
}

describe('changePort', () => {
    it('checks, writes .env, confirms compose publishes it, writes the registry, recreates, rewrites the vhost', async () => {
        const { deps, steps } = fakes()
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: true, output: 'acme live now uses port 5012, and its containers were recreated on it' })
        assert.deepEqual(steps, ['check 5012', 'env WEB_PORT=5012', 'override', 'published', 'registry 5012 docker-compose.yml,hostd.ports.yml', 'running?', 'up', 'vhost'])
    })

    it('leaves an override that is already there alone', async () => {
        const { deps, steps } = fakes()
        assert.equal((await changePort(withOverride, 'live', 5012, deps)).ok, true)
        assert.deepEqual(steps, ['check 5012', 'env WEB_PORT=5012', 'published', 'registry 5012', 'running?', 'up', 'vhost'])
    })

    it('checks and recreates with the override in the compose list', async () => {
        const seen: string[][] = []
        const { deps } = fakes({
            published: async env => { seen.push(env.composePaths); return { ok: true, ports: [5012] } },
            up: async env => { seen.push(env.composePaths); return { ok: true } },
        })
        await changePort(bare, 'live', 5012, deps)
        assert.deepEqual(seen, [
            ['/var/www/acme/docker-compose.yml', '/var/www/acme/hostd.ports.yml'],
            ['/var/www/acme/docker-compose.yml', '/var/www/acme/hostd.ports.yml'],
        ])
    })

    it('refuses when the override cannot be built, putting .env back', async () => {
        const problem = 'hostd cannot tell which service is the site (web, worker); give the others an image it recognises as a database, or publish a port from the site\'s service only'
        const { deps, steps } = fakes({ override: async () => { steps.push('override'); return { ok: false, problem } } })
        assert.deepEqual(await changePort(acme, 'live', 5012, deps), { ok: false, code: 'invalid-project', message: problem })
        assert.deepEqual(steps, ['check 5012', 'env WEB_PORT=5012', 'override', 'restore env "WEB_PORT=5010\\n"'])
    })

    it('takes the override and its compose entry away again when the recreate fails', async () => {
        const { deps, steps } = fakes({ up: async () => { steps.push('up'); return steps.filter(step => step === 'up').length === 1 ? { ok: false, message: 'up exited with code 1' } : { ok: true } } })
        assert.equal((await changePort(acme, 'live', 5012, deps)).ok, false)
        assert.deepEqual(steps.slice(4), ['registry 5012 docker-compose.yml,hostd.ports.yml', 'running?', 'up', 'restore env "WEB_PORT=5010\\n"', 'registry 5010 docker-compose.yml', 'remove override', 'up'])
    })

    it('does nothing for the port it already has', async () => {
        const { deps, steps } = fakes()
        assert.deepEqual(await changePort(acme, 'live', 5010, deps), { ok: true, output: 'acme live already uses port 5010' })
        assert.deepEqual(steps, [])
    })

    it('refuses a port the check refuses, touching nothing', async () => {
        const { deps, steps } = fakes({ checkPort: async () => ({ ok: false, code: 'bad-request', problem: 'port 5004 is in use on the host' }) })
        assert.deepEqual(await changePort(acme, 'live', 5004, deps), { ok: false, code: 'bad-request', message: 'port 5004 is in use on the host' })
        assert.deepEqual(steps, [])
    })

    it('puts .env back when compose does not publish the port', async () => {
        const { deps, steps } = fakes({ published: async () => ({ ok: true, ports: [3000] }) })
        assert.deepEqual(await changePort(acme, 'live', 5012, deps), { ok: false, code: 'bad-request', message: notPublishedProblem('/var/www/acme', 5012) })
        assert.deepEqual(steps.slice(-3), ['override', 'restore env "WEB_PORT=5010\\n"', 'remove override'])
    })

    it('puts .env back when the registry refuses the port', async () => {
        const { deps, steps } = fakes({ writePort: async () => ({ ok: false, problem: 'port 5012 is also used by other' }) })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'port 5012 is also used by other' })
        assert.deepEqual(steps.slice(-2), ['restore env "WEB_PORT=5010\\n"', 'remove override'])
    })

    it('undoes everything and brings the old port back up when the recreate fails', async () => {
        let ups = 0
        const { deps, steps } = fakes({ up: async () => { steps.push('up'); ups += 1; return ups === 1 ? { ok: false, message: 'up exited with code 1' } : { ok: true } } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok ? '' : reply.message, /up exited with code 1/)
        assert.deepEqual(steps.slice(-5), ['up', 'restore env "WEB_PORT=5010\\n"', 'registry 5010 docker-compose.yml', 'remove override', 'up'])
    })

    it('undoes everything when the vhost cannot be rewritten', async () => {
        let rewrites = 0
        const { deps, steps } = fakes({ rewriteVhost: async () => { steps.push('vhost'); rewrites += 1; return rewrites === 1 ? 'Apache refused the file' : null } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok ? '' : reply.message, /Apache refused the file/)
        assert.deepEqual(steps.slice(-6), ['vhost', 'restore env "WEB_PORT=5010\\n"', 'registry 5010 docker-compose.yml', 'remove override', 'up', 'vhost'])
    })

    it('does not start an environment that is not running', async () => {
        const { deps, steps } = fakes({ running: async () => { steps.push('running?'); return false } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: true, output: 'acme live now uses port 5012. It was not running, so it takes the port when it next starts' })
        assert.ok(!steps.includes('up'))
    })

    // A thrown error is undone exactly like an answered failure, or .env and the registry would be left
    // on the new port while the containers and the vhost stay on the old one
    it('undoes .env and the registry when asking whether it runs throws', async () => {
        const { deps, steps } = fakes({ running: async () => { steps.push('running?'); throw new Error('connect ENOENT /var/run/docker.sock') } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'acme live could not be moved to port 5012: connect ENOENT /var/run/docker.sock. It was moved back to 5010.' })
        assert.deepEqual(steps.slice(-4), ['running?', 'restore env "WEB_PORT=5010\\n"', 'registry 5010 docker-compose.yml', 'remove override'])
        assert.ok(!steps.includes('up'))
        assert.ok(!steps.includes('vhost'))
    })

    it('undoes everything and brings the old port back up when the recreate throws', async () => {
        let ups = 0
        const { deps, steps } = fakes({ up: async () => { steps.push('up'); ups += 1; if (ups === 1) throw new Error('spawn docker ENOENT'); return { ok: true } } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'acme live could not be moved to port 5012: spawn docker ENOENT. It was moved back to 5010.' })
        assert.deepEqual(steps.slice(-5), ['up', 'restore env "WEB_PORT=5010\\n"', 'registry 5010 docker-compose.yml', 'remove override', 'up'])
        assert.ok(!steps.includes('vhost'))
    })

    it('rewrites the vhost back when a throw comes after it was rewritten', async () => {
        let rewrites = 0
        const { deps, steps } = fakes({ rewriteVhost: async () => { steps.push('vhost'); rewrites += 1; if (rewrites === 1) throw new Error('rail went away'); return null } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok ? '' : reply.message, /rail went away/)
        assert.deepEqual(steps.slice(-6), ['vhost', 'restore env "WEB_PORT=5010\\n"', 'registry 5010 docker-compose.yml', 'remove override', 'up', 'vhost'])
    })

    it('does not put the registry back when the throw came before it was written', async () => {
        const { deps, steps } = fakes({ published: async () => { steps.push('published'); throw new Error('spawn docker ENOENT') } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'acme live could not be moved to port 5012: spawn docker ENOENT. It was moved back to 5010.' })
        assert.deepEqual(steps.slice(-3), ['published', 'restore env "WEB_PORT=5010\\n"', 'remove override'])
    })

    // The registry may already be written when writePort throws (its refresh is what failed), so a
    // throw from it still puts the old port back
    it('puts the registry back when writing it throws after the write', async () => {
        const { deps, steps } = fakes({
            writePort: async (port, compose) => {
                steps.push(compose ? `registry ${port} ${compose.join(',')}` : `registry ${port}`)
                if (port === 5012) throw new Error('the registry could not be re-read')
                return { ok: true }
            },
        })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'acme live could not be moved to port 5012: the registry could not be re-read. It was moved back to 5010.' })
        assert.deepEqual(steps.slice(-4), ['registry 5012 docker-compose.yml,hostd.ports.yml', 'restore env "WEB_PORT=5010\\n"', 'registry 5010 docker-compose.yml', 'remove override'])
    })

    it('carries on with the rest of the undo when putting .env back throws', async () => {
        let ups = 0
        const { deps, steps } = fakes({
            up: async () => { steps.push('up'); ups += 1; return ups === 1 ? { ok: false, message: 'up exited with code 1' } : { ok: true } },
            restorePortEnv: async () => { steps.push('restore env'); throw new Error('EACCES') },
        })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, {
            ok: false, code: 'failed',
            message: 'acme live could not be recreated on port 5012: up exited with code 1. It was moved back to 5010. .env could not be put back: EACCES.',
        })
        assert.deepEqual(steps.slice(-5), ['up', 'restore env', 'registry 5010 docker-compose.yml', 'remove override', 'up'])
    })

    // Apache would go on proxying to the old port behind a file hostd cannot rewrite, while the change
    // reported success, so an address served by hand is refused before anything is written
    it('refuses an environment whose domain is served by a hand-written vhost, touching nothing', async () => {
        const { deps, steps } = fakes({ hasOwnVhost: async () => { steps.push('own vhost?'); return false } })
        assert.deepEqual(await changePort(acme, 'live', 5012, deps), {
            ok: false, code: 'bad-request',
            message: 'acme.com is served by a hand-written vhost; adopt it from the Domains tab first, or move the port by hand',
        })
        assert.deepEqual(steps, ['own vhost?'])
    })

    it('moves an environment with no domain without asking about a vhost', async () => {
        const { deps, steps } = fakes({ hasOwnVhost: async () => { steps.push('own vhost?'); return false } })
        const reply = await changePort(bare, 'live', 5012, deps)
        assert.equal(reply.ok, true)
        assert.ok(!steps.includes('own vhost?'))
    })

    it('refuses, touching nothing, when whether hostd owns the vhost cannot be read', async () => {
        const { deps, steps } = fakes({ hasOwnVhost: async () => { steps.push('own vhost?'); throw new Error('EACCES') } })
        assert.deepEqual(await changePort(acme, 'live', 5012, deps), {
            ok: false, code: 'failed',
            message: 'acme live could not be moved to port 5012: whether hostd owns its vhost could not be read: EACCES',
        })
        assert.deepEqual(steps, ['own vhost?'])
    })
})
