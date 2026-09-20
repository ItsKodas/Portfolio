// Reads and writes env files for one environment, and nothing else. Every path first passes
// envPathProblem, the same boundary the shared module defines, so this can never touch code.

import { readdir, readFile, writeFile, rename, stat, realpath } from 'node:fs/promises'
import { posix } from 'node:path'

import type { EnvironmentEntry } from '../shared/registry.ts'
import { describeError, isWithin } from '../shared/formats.ts'
import { envPathProblem, isEnvFileName, MAX_ENV_BYTES, MAX_ENV_DEPTH, SKIP_DIRECTORIES } from '../shared/envfiles.ts'

export type EnvFileList = { path: string, example: string | null, bytes: number }[]

export type EnvFs = {
    readdir(dir: string): Promise<{ name: string, isDirectory(): boolean, isFile(): boolean }[]>
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string): Promise<void>
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
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    rename: (from, to) => rename(from, to),
    stat: async path => {
        const info = await stat(path)
        return { size: info.size }
    },
    realpath: path => realpath(path),
}

// envPathProblem is lexical only: it cannot see that a directory earlier in the path is a symlink
// pointing outside the environment folder (into /etc, or into another client's folder). This is the
// check that catches that, by resolving where the path actually leads and comparing it against the
// environment folder resolved the same way, so a symlinked environment folder is not itself mistaken
// for an escape. It resolves the target's parent, not the target itself, because on a write the env
// file may not exist yet. A realpath that throws (the parent does not exist) is a refusal, not a
// crash, same as every other failure here.
async function confinementProblem(fs: EnvFs, environment: EnvironmentEntry, relative: string, target: string): Promise<string | null> {
    try {
        const resolvedParent = await fs.realpath(posix.dirname(target))
        const resolvedRoot = await fs.realpath(environment.dir)
        if (!isWithin(resolvedRoot, resolvedParent)) return `${relative} resolves outside the environment folder`
        return null
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

export async function readEnvFile(
    environment: EnvironmentEntry, relative: string, fs: EnvFs = nodeFs,
): Promise<{ ok: true, text: string } | { ok: false, problem: string }> {
    const problem = envPathProblem(relative)
    if (problem) return { ok: false, problem }
    const target = posix.join(environment.dir, relative)
    const confinement = await confinementProblem(fs, environment, relative, target)
    if (confinement) return { ok: false, problem: confinement }
    try {
        const text = await fs.readFile(target)
        return { ok: true, text }
    } catch (error) {
        return { ok: false, problem: `the env file could not be read: ${describeError(error)}` }
    }
}

export async function writeEnvFile(
    environment: EnvironmentEntry, relative: string, text: string, fs: EnvFs = nodeFs,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    const problem = envPathProblem(relative)
    if (problem) return { ok: false, problem }

    const target = posix.join(environment.dir, relative)
    const confinement = await confinementProblem(fs, environment, relative, target)
    if (confinement) return { ok: false, problem: confinement }
    if (Buffer.byteLength(text) > MAX_ENV_BYTES) return { ok: false, problem: `the file is larger than the ${MAX_ENV_BYTES} byte limit` }

    // Same directory, so the rename is atomic: a crash leaves either the old file or the new one, never
    // a half-written one. EnvFs has no unlink, so a failed rename can leave the temporary file behind;
    // that is a stray file, not a corrupted env file, and the next write overwrites it.
    const temporary = target.replace(/([^/]+)$/, '.$1.tmp')
    try {
        await fs.writeFile(temporary, text)
        await fs.rename(temporary, target)
    } catch (error) {
        return { ok: false, problem: `the env file could not be written: ${describeError(error)}` }
    }
    return { ok: true }
}
