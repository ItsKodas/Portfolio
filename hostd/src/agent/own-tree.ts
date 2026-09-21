// deploy.ts's own DeployFs.own: gives every entry in a tree this process just created (a checkout, or a
// fresh repository directory) the ownership named in `like`, and a mode built from `like` and, for a
// regular file, from whatever mode that file already has. `like` is read fresh from the site directory
// the tree is about to become or sit beside, never guessed (see deploy.ts's own comments on `owner`).

import { chmod, chown, lchown, readdir, stat } from 'node:fs/promises'
import { posix } from 'node:path'

export type Like = { uid: number, gid: number, mode: number }

// A regular file keeps the site's own read and write bits, but its own execute bits, not the site
// directory's: a directory being traversable says nothing about which files inside it a commit marks
// executable, and the two are unrelated. Pure arithmetic, so this is tested directly rather than only
// through a real chmod: `current` is the mode the checkout already left the file at, and by the time
// this runs that is git's own answer, taken from the commit's own record (100644 or 100755 in the
// index), as long as nothing masked it away first. It very nearly was: the fetcher used to run every git
// command under a umask restrictive enough to strip the bit regardless of what git asked for, which is
// what fetcher/index.ts's own comment on its umask is about. This function cannot tell the difference
// between a bit git never set and one a caller's umask already erased; it can only keep what it is given.
export function fileModeFor(current: number, siteMode: number): number {
    return (siteMode & 0o666) | (current & 0o111)
}

// A symlink gets lchown, never chown: chown follows a symlink and would change the ownership of whatever
// it points at, and a repository is content from GitHub, not something this process wrote itself, so a
// link inside it can point anywhere at all, including outside the tree entirely. Its mode is left alone
// completely: Linux ignores a symlink's own permission bits, and Node has no lchmod on Linux to set them
// without following the link even if it mattered.
//
// One pass, chowning and chmodding every entry concurrently rather than one at a time, so the cost of
// walking a large tree (a big node_modules, say) is bounded by how many of those syscalls the platform
// will run at once rather than by the tree's own size multiplied by a network-sized latency; each entry
// is still one stat, one chown and one chmod (a directory skips the stat, since it always takes `like`'s
// mode outright), so the total work is unavoidably linear in the number of entries.
export async function ownTree(dir: string, like: Like): Promise<void> {
    await chown(dir, like.uid, like.gid)
    await chmod(dir, like.mode)
    const entries = await readdir(dir, { withFileTypes: true, recursive: true })
    await Promise.all(entries.map(async entry => {
        const path = posix.join(entry.parentPath, entry.name)
        if (entry.isSymbolicLink()) {
            await lchown(path, like.uid, like.gid)
            return
        }
        await chown(path, like.uid, like.gid)
        if (entry.isDirectory()) {
            await chmod(path, like.mode)
            return
        }
        const current = (await stat(path)).mode
        await chmod(path, fileModeFor(current, like.mode))
    }))
}
