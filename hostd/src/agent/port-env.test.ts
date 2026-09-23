import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { restorePortEnv, withEnvValue, writePortEnv } from './port-env.ts'
import type { EnvFs } from './env-files.ts'
import type { EnvironmentEntry } from '../shared/registry.ts'

function fakeFs(tree: Record<string, string> = {}) {
    const files = new Map(Object.entries(tree))
    const fs: EnvFs = {
        async readdir() { return [] },
        async readFile(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: ${path}`)
            return text
        },
        async writeFile(path, text) { files.set(path, text) },
        async rename(from, to) { files.set(to, files.get(from)!); files.delete(from) },
        async stat(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: ${path}`)
            return { size: text.length }
        },
        async realpath(path) { return path },
    }
    return { fs, files }
}

const live: EnvironmentEntry = {
    name: 'live', dir: '/var/www/acme', composePaths: ['/var/www/acme/docker-compose.yml'], branch: 'main', domain: null,
    aliases: [], port: 5010, certificate: null, deployed: null, websockets: false, flexibleSsl: false,
}

describe('withEnvValue', () => {
    it('replaces the key where it is, leaving every other line alone', () => {
        assert.equal(withEnvValue('A=1\nWEB_PORT=3000\nB=2\n', 'WEB_PORT', '5012'), 'A=1\nWEB_PORT=5012\nB=2\n')
    })

    it('reads an export prefix and spaces around = as the same key, and drops later copies', () => {
        assert.equal(withEnvValue('export WEB_PORT = 3000\nWEB_PORT=1\n', 'WEB_PORT', '5012'), 'WEB_PORT=5012\n')
    })

    it('appends the key when it is missing, on a line of its own', () => {
        assert.equal(withEnvValue('A=1', 'WEB_PORT', '5012'), 'A=1\nWEB_PORT=5012\n')
        assert.equal(withEnvValue('', 'WEB_PORT', '5012'), 'WEB_PORT=5012\n')
    })

    it('does not touch a key that merely starts with the same letters', () => {
        assert.equal(withEnvValue('WEB_PORT_ADMIN=9\n', 'WEB_PORT', '5012'), 'WEB_PORT_ADMIN=9\nWEB_PORT=5012\n')
    })
})

describe('writePortEnv', () => {
    it('writes the port into the root .env and answers what was there', async () => {
        const { fs, files } = fakeFs({ '/var/www/acme/.env': 'A=1\nWEB_PORT=3000\n' })
        assert.deepEqual(await writePortEnv(live, 'WEB_PORT', 5012, fs), { ok: true, previous: 'A=1\nWEB_PORT=3000\n' })
        assert.equal(files.get('/var/www/acme/.env'), 'A=1\nWEB_PORT=5012\n')
    })

    it('creates .env when there is none, answering null for what was there', async () => {
        const { fs, files } = fakeFs()
        assert.deepEqual(await writePortEnv(live, 'APP_PORT', 5012, fs), { ok: true, previous: null })
        assert.equal(files.get('/var/www/acme/.env'), 'APP_PORT=5012\n')
    })
})

describe('restorePortEnv', () => {
    it('puts back what was there', async () => {
        const { fs, files } = fakeFs({ '/var/www/acme/.env': 'WEB_PORT=5012\n' })
        assert.deepEqual(await restorePortEnv(live, 'WEB_PORT=3000\n', fs), { ok: true })
        assert.equal(files.get('/var/www/acme/.env'), 'WEB_PORT=3000\n')
    })

    // EnvFs has no unlink, so a file that did not exist before is left empty rather than removed
    it('empties a .env that did not exist before', async () => {
        const { fs, files } = fakeFs({ '/var/www/acme/.env': 'WEB_PORT=5012\n' })
        await restorePortEnv(live, null, fs)
        assert.equal(files.get('/var/www/acme/.env'), '')
    })
})
