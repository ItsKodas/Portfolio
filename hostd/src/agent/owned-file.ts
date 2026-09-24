// Writes a file hostd itself owns into a folder the operator owns, e.g. hostd.ports.yml beside a site's
// own compose files. A plain writeFile-then-chown would follow a symlink planted at that name: a client
// repo can commit `hostd.ports.yml -> ../other-client/.env`, and this process runs as root, so a naive
// write would overwrite and chown another tenant's file. env-files.ts's writeEnvFile carries the same
// threat for env files and defends against it the same way, which this copies: write to a random-suffix
// temp name with 'wx' (O_CREAT | O_EXCL, so it can only ever create, never follow a symlink already at
// that name), chown the temp file rather than the target, then rename the temp over the target, which
// replaces a symlink there instead of following it.

import { chown, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

export type OwnedFileFs = {
    stat(path: string): Promise<{ uid: number, gid: number }>
    writeFile(path: string, text: string, options: { flag: string, mode: number }): Promise<void>
    chown(path: string, uid: number, gid: number): Promise<void>
    rename(from: string, to: string): Promise<void>
    unlink(path: string): Promise<void>
}

const nodeFs: OwnedFileFs = {
    stat: async path => {
        const info = await stat(path)
        return { uid: info.uid, gid: info.gid }
    },
    writeFile: (path, text, options) => writeFile(path, text, { mode: options.mode, flag: options.flag }),
    chown: (path, uid, gid) => chown(path, uid, gid),
    rename: (from, to) => rename(from, to),
    unlink: path => unlink(path),
}

// The file takes its folder's owner, the same as every other file hostd puts into a site: a create and a
// deploy own the whole tree afterwards anyway, and a port change writes into a folder that is already in
// use and has no such step.
export async function writeOwnedFile(path: string, text: string, fs: OwnedFileFs = nodeFs): Promise<void> {
    const dir = posix.dirname(path)
    const like = await fs.stat(dir)
    const temporary = posix.join(dir, `.${posix.basename(path)}.${randomBytes(6).toString('hex')}`)
    try {
        await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o644 })
        await fs.chown(temporary, like.uid, like.gid)
        await fs.rename(temporary, path)
    } catch (error) {
        // Best effort: whichever step failed, the temp file is nobody's business but this call's own,
        // and leaving it behind is a stray file, not a corrupted target.
        await fs.unlink(temporary).catch(() => {})
        throw error
    }
}
