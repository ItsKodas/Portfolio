// Reads and writes env files for one environment, and nothing else. Every path first passes
// envPathProblem, the same boundary the shared module defines, so this can never touch code.

import { readdir, readFile, writeFile, rename, stat, realpath } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

import type { EnvironmentEntry } from '../shared/registry.ts'
import { describeError, isWithin } from '../shared/formats.ts'
import {
    envPathProblem, envWriteProblem, isEnvFileName, MAX_ENV_BYTES, MAX_ENV_DEPTH, SKIP_DIRECTORIES, type EnvFileList,
} from '../shared/envfiles.ts'

export type { EnvFileList }

export type EnvFs = {
    readdir(dir: string): Promise<{ name: string, isDirectory(): boolean, isFile(): boolean }[]>
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    rename(from: string, to: string): Promise<void>
    stat(path: string): Promise<{ size: number }>
    realpath(path: string): Promise<string>
}

const nodeFs: EnvFs = {
    readdir: async dir => {
        const entries = await readdir(dir, { withFileTypes: true })
        return entries.map(entry => ({ name: entry.name, isDirectory: () => entry.isDirectory(), isFile: () => entry.isFile() }))
    },
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    rename: (from, to) => rename(from, to),
    stat: async path => {
        const info = await stat(path)
        return { size: info.size }
    },
    realpath: path => realpath(path),
}

// envPathProblem is lexical only: it cannot see that some path along the way is a symlink pointing
// outside the environment folder (into /etc, or into another client's folder). This resolves `path`
// with realpath and confirms the result is still inside the environment folder, which is also
// resolved so a symlinked environment folder is not itself mistaken for an escape.
async function confinedRealpath(fs: EnvFs, environment: EnvironmentEntry, path: string): Promise<{ ok: true, resolved: string } | { ok: false }> {
    const resolvedRoot = await fs.realpath(environment.dir)
    const resolved = await fs.realpath(path)
    return isWithin(resolvedRoot, resolved) ? { ok: true, resolved } : { ok: false }
}

// The parent check every read and write needs: a directory earlier in the path can be a symlink,
// which envPathProblem's lexical check cannot see. Checks the parent, not the target itself, because
// on a write the env file may not exist yet. A realpath that throws (the parent does not exist) is a
// refusal, not a crash, same as every other failure here.
async function parentConfinementProblem(fs: EnvFs, environment: EnvironmentEntry, relative: string, target: string): Promise<string | null> {
    try {
        const result = await confinedRealpath(fs, environment, posix.dirname(target))
        return result.ok ? null : `${relative} resolves outside the environment folder`
    } catch (error) {
        return `${relative} could not be resolved: ${describeError(error)}`
    }
}

// Depth counts directories already descended, root is 0. A file found here has depth + 1 path segments,
// which is exactly what envPathProblem checks against MAX_ENV_DEPTH, so the two never disagree about what
// is too deep. Stopping the recursion, not just filtering the result, is what keeps a huge repo cheap to walk.
//
// `found` collects the env files themselves (isEnvFileName accepts them). `allFiles` collects every file
// name seen in a visited directory, env file or not, because a sibling like app.env.example does not
// itself satisfy isEnvFileName but is still what listEnvFiles should point to as that file's example.
async function walk(fs: EnvFs, root: string, dir: string, depth: number, found: string[], allFiles: Set<string>): Promise<void> {
    let entries: { name: string, isDirectory(): boolean, isFile(): boolean }[]
    try {
        entries = await fs.readdir(dir)
    } catch {
        return
    }
    for (const entry of entries) {
        // Explicitly neither: a symlink is what EnvFs's readdir reports when an entry is neither a
        // real directory nor a real file (the same way Node's own Dirent, built from lstat and never
        // from stat, reports one it has not followed). It falls through untouched: not descended into,
        // not listed. Without this, a symlinked directory inside the environment (checked into a repo,
        // pointing at /etc or another client's folder) would let a listing walk it and disclose what
        // env files exist outside the environment folder, and their sizes.
        if (entry.isDirectory()) {
            if (SKIP_DIRECTORIES.has(entry.name)) continue
            if (depth < MAX_ENV_DEPTH - 1) await walk(fs, root, posix.join(dir, entry.name), depth + 1, found, allFiles)
        } else if (entry.isFile()) {
            const relative = posix.relative(root, posix.join(dir, entry.name))
            allFiles.add(relative)
            if (isEnvFileName(entry.name)) found.push(relative)
        }
    }
}

export async function listEnvFiles(environment: EnvironmentEntry, fs: EnvFs = nodeFs): Promise<EnvFileList> {
    const found: string[] = []
    const allFiles = new Set<string>()
    await walk(fs, environment.dir, environment.dir, 0, found, allFiles)

    const list: EnvFileList = []
    for (const relative of found) {
        const exampleRelative = `${relative}.example`
        const example = allFiles.has(exampleRelative) ? exampleRelative : null
        // A file the walk just saw can still vanish before this runs. That is a listing with one
        // fewer entry, not a failure: the same "return, never throw" rule this module follows everywhere.
        let size: number
        try {
            size = (await fs.stat(posix.join(environment.dir, relative))).size
        } catch {
            continue
        }
        list.push({ path: relative, example, bytes: size })
    }
    return list
}

// A freshly cloned repo usually commits `<name>.example` (an env file's own example is always exactly its
// name plus `.example`, as computed above) and gitignores `<name>` itself, and a compose file usually
// declares `env_file: <name>`. `docker compose config` fails on a missing env_file, which would otherwise
// roll back a clone that has done nothing wrong, before the operator ever gets to fill the real file in.
// For every `<name>.example` this walk finds whose `<name>` both looks like an env file and does not
// exist yet, this creates `<name>` empty: empty, never a copy of the example, so a placeholder value (a
// fake password, a fake API key) can never become what a freshly created site actually runs with. Reuses
// walk() rather than a fresh readdir of its own, so this only ever creates a file the same symlink-aware
// traversal that backs listEnvFiles would itself have found. Returns the paths it created, for the log.
export async function createMissingEnvFiles(dir: string, fs: EnvFs = nodeFs): Promise<string[]> {
    const found: string[] = []
    const allFiles = new Set<string>()
    await walk(fs, dir, dir, 0, found, allFiles)

    const created: string[] = []
    for (const relative of allFiles) {
        if (!relative.endsWith('.example')) continue
        const real = relative.slice(0, -'.example'.length)
        if (!isEnvFileName(posix.basename(real)) || allFiles.has(real)) continue
        try {
            await fs.writeFile(posix.join(dir, real), '', { flag: 'wx' })
            created.push(real)
        } catch {
            // EEXIST (something else created it, symlink or not, between the walk and here) or any other
            // failure: this call has nothing at stake in it existing, so it is not worth failing
            // provisioning over. wx never follows a symlink already at that name, the same as
            // writeEnvFile's own temp file relies on below.
        }
    }
    return created
}

export async function readEnvFile(
    environment: EnvironmentEntry, relative: string, fs: EnvFs = nodeFs,
): Promise<{ ok: true, text: string } | { ok: false, problem: string }> {
    const problem = envPathProblem(relative)
    if (problem) return { ok: false, problem }
    const target = posix.join(environment.dir, relative)
    const parentProblem = await parentConfinementProblem(fs, environment, relative, target)
    if (parentProblem) return { ok: false, problem: parentProblem }

    // The parent check above stops a symlinked directory from redirecting the read, but the leaf
    // itself can also be a symlink: a repo can check in `.env -> /etc/passwd` or
    // `.env -> ../other-client/live/.env`, which passes both the lexical check and the parent check,
    // and readFile would happily follow it. Resolve and confine the leaf too, unless it does not exist
    // yet, which is not this check's problem: fall through and let readFile report that below.
    try {
        const result = await confinedRealpath(fs, environment, target)
        if (!result.ok) return { ok: false, problem: `${relative} resolves outside the environment folder` }
    } catch {
        // Does not exist (or could not otherwise be resolved): readFile below reports this on its own.
    }

    try {
        const text = await fs.readFile(target)
        return { ok: true, text }
    } catch (error) {
        return { ok: false, problem: `the env file could not be read: ${describeError(error)}` }
    }
}

// readEnvFile, except that a file that is not there is an answer (null) rather than a failure. The port
// writer needs the difference: it creates .env when a repo has none, and puts back exactly what was there
// when a port change is undone.
export async function readEnvFileIfPresent(
    environment: EnvironmentEntry, relative: string, fs: EnvFs = nodeFs,
): Promise<{ ok: true, text: string | null } | { ok: false, problem: string }> {
    try {
        await fs.stat(posix.join(environment.dir, relative))
    } catch {
        return { ok: true, text: null }
    }
    return readEnvFile(environment, relative, fs)
}

export async function writeEnvFile(
    environment: EnvironmentEntry, relative: string, text: string, fs: EnvFs = nodeFs,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    const problem = envWriteProblem(relative)
    if (problem) return { ok: false, problem }

    const target = posix.join(environment.dir, relative)
    const parentProblem = await parentConfinementProblem(fs, environment, relative, target)
    if (parentProblem) return { ok: false, problem: parentProblem }
    if (Buffer.byteLength(text) > MAX_ENV_BYTES) return { ok: false, problem: `the file is larger than the ${MAX_ENV_BYTES} byte limit` }

    // Unlike readEnvFile, this does not also resolve and confine the target itself: if the target is a
    // symlink (say, checked in pointing at /etc/passwd), rename(2) replaces that directory entry rather
    // than following it, so the write lands on target's own name, not on whatever it pointed to. Do not
    // add a leaf check here on the assumption that write has the same hole read did; it does not.
    //
    // The temp file is a different story. A predictable name (".env.tmp") could be pre-planted as a
    // symlink by anything that can write into the environment folder (the same repo-content assumption
    // as every symlink finding above), redirecting this write before the safe rename below ever runs.
    // Two defenses instead of a check, because a check here would just be a second race: a random
    // suffix, so the name cannot be guessed and pre-planted, and 'wx' (O_CREAT | O_EXCL), which fails
    // with EEXIST if anything at all already sits at that path, symlink or not, rather than opening
    // through it. An EEXIST is a refusal, not a retry with a new name: retrying would only turn a closed
    // race into an open one.
    const temporary = posix.join(posix.dirname(target), `.${posix.basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
    // Same directory, so the rename below is atomic: a crash leaves either the old file or the new one,
    // never a half-written one. EnvFs has no unlink, so a failed rename can leave the temporary file
    // behind; that is a stray file, not a corrupted env file, and the next write overwrites it.
    try {
        await fs.writeFile(temporary, text, { flag: 'wx' })
        await fs.rename(temporary, target)
    } catch (error) {
        return { ok: false, problem: `the env file could not be written: ${describeError(error)}` }
    }
    return { ok: true }
}
