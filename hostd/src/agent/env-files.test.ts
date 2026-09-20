import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { listEnvFiles, readEnvFile, writeEnvFile, type EnvFs } from './env-files.ts'
import { parseRegistry, type EnvironmentEntry } from '../shared/registry.ts'
import { MAX_ENV_BYTES } from '../shared/envfiles.ts'

const DIR = '/var/www/acme'

function environment(dir = DIR): EnvironmentEntry {
    const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    services:
      web: { role: site }
    environments:
      live:
        dir: ${dir}
        port: 5010
`)
    const project = registry.projects.get('acme')
    assert.ok(project, JSON.stringify([...registry.invalid]))
    const live = project.environments.get('live')
    assert.ok(live)
    return live
}

// A tiny in-memory filesystem, keyed by full posix path to file contents. Directories exist only
// implicitly, as prefixes of file paths, same as a real filesystem would show through readdir.
function setup(tree: Record<string, string> = {}) {
    const files = new Map(Object.entries(tree))
    const writeCalls: { path: string, text: string }[] = []
    const renameCalls: { from: string, to: string }[] = []

    const fs: EnvFs = {
        async readdir(dir) {
            const prefix = dir.endsWith('/') ? dir : `${dir}/`
            const seen = new Map<string, boolean>()
            for (const path of files.keys()) {
                if (!path.startsWith(prefix)) continue
                const rest = path.slice(prefix.length)
                const [name, ...more] = rest.split('/')
                if (name) seen.set(name, more.length > 0)
            }
            return [...seen.entries()].map(([name, isDir]) => ({
                name,
                isDirectory: () => isDir,
                isFile: () => !isDir,
            }))
        },
        async readFile(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
            return text
        },
        async writeFile(path, text) {
            writeCalls.push({ path, text })
            files.set(path, text)
        },
        async rename(from, to) {
            renameCalls.push({ from, to })
            const text = files.get(from)
            if (text === undefined) throw new Error(`ENOENT: no such file, rename '${from}'`)
            files.delete(from)
            files.set(to, text)
        },
        async stat(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, stat '${path}'`)
            return { size: Buffer.byteLength(text) }
        },
    }
    return { fs, files, writeCalls, renameCalls }
}

describe('listEnvFiles', () => {
    it('lists every env file in the environment, with its example beside it', async () => {
        const { fs } = setup({
            [`${DIR}/.env`]: 'A=1',
            [`${DIR}/.env.example`]: 'A=',
            [`${DIR}/api/.env.test`]: 'B=12',
            [`${DIR}/api/app.env`]: 'C=123',
            [`${DIR}/api/app.env.example`]: 'C=',
        })
        const list = await listEnvFiles(environment(), fs)
        const byPath = new Map(list.map(entry => [entry.path, entry]))
        // api/app.env.example is not itself an env file name (isEnvFileName rejects it), so it is not
        // its own entry here: it only ever shows up as the example paired with api/app.env.
        assert.equal(byPath.size, 4)
        assert.deepEqual(byPath.get('.env'), { path: '.env', example: '.env.example', bytes: 3 })
        assert.equal(byPath.get('.env.example')?.example, null)
        assert.deepEqual(byPath.get('api/.env.test'), { path: 'api/.env.test', example: null, bytes: 4 })
        assert.deepEqual(byPath.get('api/app.env'), { path: 'api/app.env', example: 'api/app.env.example', bytes: 5 })
    })

    it('skips .git and node_modules, which can hold thousands of files, and stops at the depth limit', async () => {
        const { fs } = setup({
            [`${DIR}/.env`]: 'A=1',
            [`${DIR}/.git/.env`]: 'SECRET=leak',
            [`${DIR}/node_modules/pkg/.env`]: 'SECRET=leak2',
            [`${DIR}/a/b/c/d/.env`]: 'TOO_DEEP=1',
        })
        const list = await listEnvFiles(environment(), fs)
        assert.deepEqual(list.map(entry => entry.path), ['.env'])
    })
})

describe('readEnvFile', () => {
    it('refuses to read anything that is not an env file', async () => {
        const { fs } = setup({ [`${DIR}/src/index.ts`]: 'code' })
        const result = await readEnvFile(environment(), 'src/index.ts', fs)
        assert.equal(result.ok, false)
        if (!result.ok) assert.match(result.problem, /env file/)
    })

    it('reports a missing file as a problem rather than throwing', async () => {
        const { fs } = setup({})
        const result = await readEnvFile(environment(), '.env', fs)
        assert.equal(result.ok, false)
        if (!result.ok) assert.ok(result.problem.length > 0)
    })
})

describe('writeEnvFile', () => {
    it('refuses to write anything that is not an env file, and writes nothing', async () => {
        const { fs, writeCalls } = setup({ [`${DIR}/src/index.ts`]: 'code' })
        const result = await writeEnvFile(environment(), 'src/index.ts', 'X=1', fs)
        assert.equal(result.ok, false)
        if (!result.ok) assert.match(result.problem, /env file/)
        assert.deepEqual(writeCalls, [])
    })

    it('refuses text larger than the limit', async () => {
        const { fs, writeCalls } = setup({})
        const text = 'X'.repeat(MAX_ENV_BYTES + 1)
        const result = await writeEnvFile(environment(), '.env', text, fs)
        assert.equal(result.ok, false)
        if (!result.ok) assert.match(result.problem, /limit/)
        assert.deepEqual(writeCalls, [])
    })

    it('writes through a temporary file and renames, so a crash cannot truncate a live env file', async () => {
        const { fs, writeCalls, renameCalls, files } = setup({ [`${DIR}/.env`]: 'OLD=1' })
        const result = await writeEnvFile(environment(), '.env', 'NEW=2', fs)
        assert.equal(result.ok, true)
        assert.equal(writeCalls.length, 1)
        assert.notEqual(writeCalls[0]!.path, `${DIR}/.env`)
        assert.equal(writeCalls[0]!.path.slice(0, DIR.length + 1), `${DIR}/`)
        assert.deepEqual(renameCalls, [{ from: writeCalls[0]!.path, to: `${DIR}/.env` }])
        assert.equal(files.get(`${DIR}/.env`), 'NEW=2')
    })

    it('never includes file contents in a problem message', async () => {
        const secret = 'DB_PASSWORD=super-secret-value'

        const { fs: fsForOversize } = setup({})
        const oversize = await writeEnvFile(environment(), '.env', secret.repeat(10000), fsForOversize)
        assert.equal(oversize.ok, false)
        if (!oversize.ok) assert.equal(oversize.problem.includes(secret), false)

        const { fs } = setup({ [`${DIR}/.env`]: secret })
        const failingFs: EnvFs = { ...fs, writeFile: async () => { throw new Error('disk full') } }
        const failed = await writeEnvFile(environment(), '.env', secret, failingFs)
        assert.equal(failed.ok, false)
        if (!failed.ok) assert.equal(failed.problem.includes(secret), false)
    })
})
