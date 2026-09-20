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
//
// `symlinks` maps a directory's apparent path to what it really is, e.g. `/var/www/acme/shared` to
// `/etc`. Every operation resolves its path through that map first, walking segment by segment the
// same way a real filesystem would when a directory partway through the path is a symlink, so a test
// can write to an "apparent" path and observe the effect land on the real one underneath it.
function setup(tree: Record<string, string> = {}, symlinks: Record<string, string> = {}) {
    const files = new Map(Object.entries(tree))
    const links = new Map(Object.entries(symlinks))
    const writeCalls: { path: string, text: string }[] = []
    const renameCalls: { from: string, to: string }[] = []

    function resolve(path: string): string {
        const parts = path.split('/').filter(Boolean)
        let resolved = ''
        for (const part of parts) {
            resolved = `${resolved}/${part}`
            resolved = links.get(resolved) ?? resolved
        }
        return resolved
    }

    const fs: EnvFs = {
        async readdir(dir) {
            // A name that is itself a registered symlink (its full apparent path is a `links` key)
            // is reported as neither a directory nor a file, the same way a real Dirent (built from
            // lstat, never from stat) reports a symlink entry it has not followed, whatever it points
            // to. This is what lets a test prove a symlinked directory is not walked.
            const symlinkNames = new Set<string>()
            for (const apparent of links.keys()) {
                const slash = apparent.lastIndexOf('/')
                const parent = slash <= 0 ? '/' : apparent.slice(0, slash)
                if (parent === dir) symlinkNames.add(apparent.slice(slash + 1))
            }

            const real = resolve(dir)
            const prefix = real.endsWith('/') ? real : `${real}/`
            const seen = new Map<string, boolean>()
            for (const path of files.keys()) {
                if (!path.startsWith(prefix)) continue
                const rest = path.slice(prefix.length)
                const [name, ...more] = rest.split('/')
                if (name && !symlinkNames.has(name)) seen.set(name, more.length > 0)
            }
            const entries = [...seen.entries()].map(([name, isDir]) => ({
                name,
                isDirectory: () => isDir,
                isFile: () => !isDir,
            }))
            for (const name of symlinkNames) entries.push({ name, isDirectory: () => false, isFile: () => false })
            return entries
        },
        async readFile(path) {
            const text = files.get(resolve(path))
            if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
            return text
        },
        async writeFile(path, text) {
            writeCalls.push({ path, text })
            files.set(resolve(path), text)
        },
        async rename(from, to) {
            renameCalls.push({ from, to })
            const realFrom = resolve(from)
            const text = files.get(realFrom)
            if (text === undefined) throw new Error(`ENOENT: no such file, rename '${from}'`)
            files.delete(realFrom)
            files.set(resolve(to), text)
        },
        async stat(path) {
            const text = files.get(resolve(path))
            if (text === undefined) throw new Error(`ENOENT: no such file, stat '${path}'`)
            return { size: Buffer.byteLength(text) }
        },
        async realpath(path) {
            return resolve(path)
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

    it('does not walk into a symlinked directory, so a listing cannot disclose what is outside', async () => {
        const { fs } = setup(
            { [`${DIR}/.env`]: 'A=1', '/etc/.env': 'SECRET=leak' },
            { [`${DIR}/shared`]: '/etc' },
        )
        const list = await listEnvFiles(environment(), fs)
        assert.deepEqual(list.map(entry => entry.path), ['.env'])
    })

    it('omits an env file whose stat fails between the walk and the read, instead of throwing the whole listing', async () => {
        const { fs } = setup({
            [`${DIR}/.env`]: 'A=1',
            [`${DIR}/.env.local`]: 'B=1',
        })
        const flaky: EnvFs = {
            ...fs,
            stat: async path => {
                if (path === `${DIR}/.env.local`) throw new Error('ENOENT: no such file or directory')
                return fs.stat(path)
            },
        }
        const list = await listEnvFiles(environment(), flaky)
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

    // The parent-directory check alone does not catch this: `.env` itself, not any directory above it,
    // is the symlink, so the parent resolves to the environment folder just fine.
    it('a symlinked file inside the environment pointing outside makes a read refuse, and the outside file\'s contents never appear in the result', async () => {
        const outside = 'root:x:0:0:root:/root:/bin/bash'
        const { fs } = setup(
            { '/etc/passwd': outside },
            { [`${DIR}/.env`]: '/etc/passwd' },
        )
        const result = await readEnvFile(environment(), '.env', fs)
        assert.equal(result.ok, false)
        if (!result.ok) {
            assert.match(result.problem, /outside the environment folder/)
            assert.equal(result.problem.includes(outside), false)
        }
    })

    it('a symlinked file pointing at another file inside the same environment still reads, so an ordinary symlink within the site is not broken', async () => {
        const { fs } = setup(
            { [`${DIR}/.env.production`]: 'A=1' },
            { [`${DIR}/.env`]: `${DIR}/.env.production` },
        )
        const result = await readEnvFile(environment(), '.env', fs)
        assert.deepEqual(result, { ok: true, text: 'A=1' })
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

describe('path confinement', () => {
    // A path can be lexically fine (envPathProblem sees no '..' and a proper env file name) and still
    // lead outside the environment folder, if some directory along the way is a symlink. This is the
    // scenario that makes that dangerous: a repo checked out into the environment folder containing a
    // symlinked directory pointing at /etc, or at another client's folder.
    it('a symlinked directory inside the environment makes a read and a write refuse, and the write leaves the outside file untouched', async () => {
        const { fs, files, writeCalls } = setup(
            { '/etc/.env': 'OUTSIDE=1' },
            { [`${DIR}/shared`]: '/etc' },
        )

        const read = await readEnvFile(environment(), 'shared/.env', fs)
        assert.equal(read.ok, false)
        if (!read.ok) assert.match(read.problem, /outside the environment folder/)

        const write = await writeEnvFile(environment(), 'shared/.env', 'X=1', fs)
        assert.equal(write.ok, false)
        if (!write.ok) assert.match(write.problem, /outside the environment folder/)
        assert.deepEqual(writeCalls, [])
        assert.equal(files.get('/etc/.env'), 'OUTSIDE=1')
    })

    it('a symlinked environment folder itself still works, so a site living behind a symlink is not broken', async () => {
        const linkDir = '/var/www/acme-link'
        const realDir = '/var/www/acme-real'
        const { fs, files } = setup(
            { [`${realDir}/.env`]: 'A=1' },
            { [linkDir]: realDir },
        )

        const read = await readEnvFile(environment(linkDir), '.env', fs)
        assert.deepEqual(read, { ok: true, text: 'A=1' })

        const write = await writeEnvFile(environment(linkDir), '.env', 'A=2', fs)
        assert.equal(write.ok, true)
        assert.equal(files.get(`${realDir}/.env`), 'A=2')
    })

    it('the refusal names the path and never the file\'s contents', async () => {
        const secret = 'DB_PASSWORD=super-secret-value'
        const { fs } = setup(
            { '/etc/.env': 'OUTSIDE=1' },
            { [`${DIR}/shared`]: '/etc' },
        )

        const result = await writeEnvFile(environment(), 'shared/.env', secret, fs)
        assert.equal(result.ok, false)
        if (!result.ok) {
            assert.match(result.problem, /shared\/\.env/)
            assert.equal(result.problem.includes(secret), false)
        }
    })

    it('treats a realpath failure as a refusal, not a thrown error', async () => {
        const { fs } = setup({})
        const failingFs: EnvFs = { ...fs, realpath: async () => { throw new Error('ENOENT: no such file or directory') } }
        const result = await readEnvFile(environment(), '.env', failingFs)
        assert.equal(result.ok, false)
    })
})
