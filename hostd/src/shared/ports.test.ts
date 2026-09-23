import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from './registry.ts'
import { choosePort, portProblem, PORT_RANGE } from './ports.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:a/acme.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5000 }
      test: { dir: /var/www/acme-test, port: 5001 }
`)

const nothing = new Set<number>()

describe('PORT_RANGE', () => {
    it('is 5000 and up', () => {
        assert.deepEqual(PORT_RANGE, { from: 5000, to: 65535 })
    })
})

describe('portProblem', () => {
    it('allows a port nothing holds', () => {
        assert.equal(portProblem(5002, registry, nothing), null)
    })

    it('refuses a port below 5000 or above 65535, or one that is not a whole number', () => {
        for (const port of [4999, 65536, 5000.5, Number.NaN]) {
            assert.equal(portProblem(port, registry, nothing), 'port must be a whole number from 5000 to 65535')
        }
    })

    it('names the environment that already holds a port', () => {
        assert.equal(portProblem(5001, registry, nothing), 'port 5001 is taken by acme (test)')
    })

    it('refuses a port something on the host is listening on', () => {
        assert.equal(portProblem(5004, registry, new Set([5004])), 'port 5004 is in use on the host')
    })

    // The environment being changed is running on its own port, so the host listing has it too.
    it('lets an environment keep its own port', () => {
        assert.equal(portProblem(5000, registry, new Set([5000]), { project: 'acme', environment: 'live' }), null)
    })

    it('still refuses its sibling environment\'s port', () => {
        assert.equal(portProblem(5001, registry, nothing, { project: 'acme', environment: 'live' }), 'port 5001 is taken by acme (test)')
    })
})

describe('choosePort', () => {
    it('gives the lowest port the registry is not using', () => {
        assert.deepEqual(choosePort(registry, nothing), { ok: true, port: 5002 })
    })

    it('skips a port something is already listening on, even when the registry does not know it', () => {
        assert.deepEqual(choosePort(registry, new Set([5002, 5003])), { ok: true, port: 5004 })
    })

    it('refuses when the range is full, naming the range', () => {
        const result = choosePort(registry, new Set([5002]), { from: 5000, to: 5002 })
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.problem : '', /5000 to 5002/)
    })
})
