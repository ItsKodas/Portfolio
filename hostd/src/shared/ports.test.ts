import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from './registry.ts'
import { choosePort, takenPorts, type PortCheck } from './ports.ts'

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

const free: PortCheck = async () => false

describe('takenPorts', () => {
    it('collects the port of every environment', () => {
        assert.deepEqual([...takenPorts(registry)].sort(), [5000, 5001])
    })
})

describe('choosePort', () => {
    it('gives the lowest port the registry is not using', async () => {
        assert.deepEqual(await choosePort(registry, free), { ok: true, port: 5002 })
    })

    it('skips a port something is already listening on, even when the registry does not know it', async () => {
        const busy: PortCheck = async port => port === 5002 || port === 5003
        assert.deepEqual(await choosePort(registry, busy), { ok: true, port: 5004 })
    })

    it('refuses when the range is full, naming the range', async () => {
        const result = await choosePort(registry, async () => true, { from: 5000, to: 5002 })
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.problem : '', /5000 to 5002/)
    })
})
