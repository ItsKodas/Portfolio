// Reads and writes env files for one environment, and nothing else. Every path first passes
// envPathProblem, the same boundary the shared module defines, so this can never touch code.

import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import { posix } from 'node:path'

import type { EnvironmentEntry } from '../shared/registry.ts'
import { describeError } from '../shared/formats.ts'
import { envPathProblem, isEnvFileName, MAX_ENV_BYTES, MAX_ENV_DEPTH, SKIP_DIRECTORIES } from '../shared/envfiles.ts'

export type EnvFileList = { path: string, example: string | null, bytes: number }[]

export type EnvFs = {
    readdir(dir: string): Promise<{ name: string, isDirectory(): boolean, isFile(): boolean }[]>
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    stat(path: string): Promise<{ size: number }>
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
        const { size } = await fs.stat(posix.join(environment.dir, relative))
        list.push({ path: relative, example, bytes: size })
    }
    return list
}

export async function readEnvFile(
    environment: EnvironmentEntry, relative: string, fs: EnvFs = nodeFs,
): Promise<{ ok: true, text: string } | { ok: false, problem: string }> {
    const problem = envPathProblem(relative)
    if (problem) return { ok: false, problem }
    try {
        const text = await fs.readFile(posix.join(environment.dir, relative))
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
    if (Buffer.byteLength(text) > MAX_ENV_BYTES) return { ok: false, problem: `the file is larger than the ${MAX_ENV_BYTES} byte limit` }

    const target = posix.join(environment.dir, relative)
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
