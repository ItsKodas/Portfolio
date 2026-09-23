import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { deployTrees, migrationTarget, migratingOf, composeNameOf, locationIn, buildArgv, upArgv, downArgv, runCompose } from './deploy-compose.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { Runner } from './compose.ts'

const REGISTRY_YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [deploy]
    environments:
      live:
        dir: /var/www/acme
        compose: [docker-compose.yml, docker-compose.prod.yml]
        branch: main
        port: 5010
      test:
        dir: /var/www/acme-test
        branch: develop
        port: 5110
`

const registry = parseRegistry(REGISTRY_YAML)
const live = registry.projects.get('acme')!.environments.get('live')!
const test = registry.projects.get('acme')!.environments.get('test')!

describe('deploy trees', () => {
    it('names the trees beside the environment folder', () => {
        assert.deepEqual(deployTrees('/var/www/acme'), {
            dir: '/var/www/acme',
            next: '/var/www/acme.next',
            prev: '/var/www/acme.prev',
            repo: '/var/www/acme.git',
            git: '/var/www/acme/.git',
            site: null,
        })
    })

    it('takes the compose project name from the folder, which is what the guard already enforces', () => {
        assert.equal(composeNameOf(live), 'acme')
        assert.equal(composeNameOf(test), 'acme-test')
    })

    it('moves every compose file the registry named into another tree, in the registry order', () => {
        assert.deepEqual(locationIn(live, '/var/www/acme.next'), {
            dir: '/var/www/acme.next',
            composePaths: ['/var/www/acme.next/docker-compose.yml', '/var/www/acme.next/docker-compose.prod.yml'],
        })
    })
})

describe('compose commands', () => {
    it('pins the project name, so a build in acme.next produces acme images', () => {
        assert.deepEqual(buildArgv(locationIn(live, '/var/www/acme.next'), 'acme'), [
            'compose', '--project-name', 'acme', '--project-directory', '/var/www/acme.next',
            '-f', '/var/www/acme.next/docker-compose.yml', '-f', '/var/www/acme.next/docker-compose.prod.yml',
            'build',
        ])
    })

    it('starts without building or pulling, because the build already happened', () => {
        assert.deepEqual(upArgv(locationIn(test, '/var/www/acme-test'), 'acme-test'), [
            'compose', '--project-name', 'acme-test', '--project-directory', '/var/www/acme-test',
            '-f', '/var/www/acme-test/docker-compose.yml',
            'up', '-d', '--no-build', '--pull', 'never',
        ])
    })

    it('takes the old copy down with its orphans, and never its volumes', () => {
        const argv = downArgv(locationIn(test, '/var/www/acme-test'), 'acme-test')
        assert.deepEqual(argv.slice(-2), ['down', '--remove-orphans'])
        assert.equal(argv.includes('-v'), false)
        assert.equal(argv.includes('--volumes'), false)
    })
})

describe('runCompose', () => {
    const runner = (result: { exitCode: number | null, timedOut?: boolean, stderr?: string }): Runner =>
        async () => ({ exitCode: result.exitCode, stdout: 'building', stderr: result.stderr ?? '', timedOut: result.timedOut ?? false })

    it('returns the output on success', async () => {
        const result = await runCompose(['compose', 'build'], 1000, runner({ exitCode: 0 }))
        assert.deepEqual(result, { ok: true, output: 'building' })
    })

    it('returns the exit code and both streams on failure, never throws', async () => {
        const result = await runCompose(['compose', 'build'], 1000, runner({ exitCode: 2, stderr: 'no such file' }))
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /exited with code 2/)
        assert.match(result.output, /no such file/)
    })

    it('says so when the command timed out', async () => {
        const result = await runCompose(['compose', 'build'], 1000, runner({ exitCode: null, timedOut: true }))
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /timed out/)
    })

    it('names the down it was running, not the flag the argv happens to end with', async () => {
        const argv = downArgv(locationIn(test, '/var/www/acme-test'), 'acme-test')
        const result = await runCompose(argv, 1000, runner({ exitCode: 1 }))
        assert.match(result.ok === false ? result.message : '', /^down exited/)
    })
})

describe('deployTrees by layout', () => {
    it('keeps the flat siblings for a flat dir', () => {
        assert.deepEqual(deployTrees('/var/www/acme'), {
            dir: '/var/www/acme', next: '/var/www/acme.next', prev: '/var/www/acme.prev', repo: '/var/www/acme.git', git: '/var/www/acme/.git', site: null,
        })
    })

    it('puts everything under the site for a nested dir', () => {
        assert.deepEqual(deployTrees('/var/www/acme/test'), {
            dir: '/var/www/acme/test', next: '/var/www/acme/next/test', prev: '/var/www/acme/prev/test', repo: '/var/www/acme/git', git: '/var/www/acme/test/.git', site: '/var/www/acme',
        })
    })
})

describe('migrationTarget', () => {
    const registry = (live: string, test: string) => parseRegistry(`projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    environments:
      live: { dir: ${live}, port: 5010 }
      test: { dir: ${test}, port: 5011 }
`).projects.get('acme')!

    it('sends a flat live under a site of its own folder name', () => {
        const project = registry('/var/www/acme', '/var/www/acme-test')
        assert.equal(migrationTarget(project, project.environments.get('live')!)!.dir, '/var/www/acme/live')
    })

    it('holds a flat test back until live is nested', () => {
        const project = registry('/var/www/acme', '/var/www/acme-test')
        assert.equal(migrationTarget(project, project.environments.get('test')!), null)
    })

    it('sends a flat test under live once live is nested', () => {
        const project = registry('/var/www/acme/live', '/var/www/acme-test')
        const target = migrationTarget(project, project.environments.get('test')!)!
        assert.equal(target.dir, '/var/www/acme/test')
        assert.equal(target.repo, '/var/www/acme/git')
    })

    it('has nothing to do for a nested environment', () => {
        const project = registry('/var/www/acme/live', '/var/www/acme/test')
        assert.equal(migrationTarget(project, project.environments.get('live')!), null)
    })

    it('uses the registry compose name, not the folder', () => {
        const project = registry('/var/www/acme/live', '/var/www/acme/test')
        assert.equal(composeNameOf(project.environments.get('test')!), 'acme-test')
    })
})
