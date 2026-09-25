// A short-lived container for file work on paths a client can change. A client container bind-mounts
// its own checkout read-write, so it can swap a folder in it for a symlink between the agent checking a
// path and the agent using it. The agent runs as root with all of /var/www, so that symlink would be
// followed into another site. Run in here instead, the same symlink resolves in the helper's own mount
// table, which holds only the folders the step may touch: /var/www/<other site> is not there, and `..`
// out of a mount's root stays at that root. The checks the callers make first are still what give a clear
// reason; this is what makes them hold.
//
// The helper runs the agent's own image (sqlite3, busybox cp and node are in it), looked up from the
// agent's own container, so nothing is pulled, as host-ports.ts's probe does. The same lookup reads the
// agent's bind mounts: a mount source is a host path, and the agent's /backups, say, is the host's
// backup disk under another name.

import { randomBytes } from 'node:crypto'

import { isWithin } from '../shared/formats.ts'
import { tail, type Runner, type RunResult } from './compose.ts'

const INSPECT_TIMEOUT_MS = 15_000
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/
// What --mount reads as one field: no comma (the field separator), no quote, nothing on another line
const MOUNTABLE = /^\/[^,"'\n\r]*$/

// source is a path as the agent sees it, translated to the host's, unless host says it already is one
// (a compose bind mount's source, say)
export type HelperMount = { source: string, target: string, readOnly?: boolean, host?: boolean }
export type IoHelper = (mounts: HelperMount[], argv: string[], timeoutMs: number) => Promise<RunResult>

type AgentMount = { Type: string, Source: string, Destination: string }

// No network, a read-only root with a scratch /tmp, root without the rest of root's power: CHOWN,
// DAC_OVERRIDE, FOWNER and FSETID are what cp -a needs to keep a tree's owners and modes, and sqlite3 to
// read a file the site's own user owns.
export function helperArgv(image: string, name: string, mounts: Array<Omit<HelperMount, 'host'>>, argv: string[]): string[] {
    const flags: string[] = []
    for (const mount of mounts) {
        for (const path of [mount.source, mount.target]) {
            if (!MOUNTABLE.test(path)) throw new Error(`${JSON.stringify(path)} cannot be mounted into the helper`)
        }
        flags.push('--mount', `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`)
    }
    const [command, ...rest] = argv
    return [
        'run', '--rm', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp',
        '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--cap-add', 'FSETID',
        '--security-opt', 'no-new-privileges', '--pull', 'never', '--user', '0:0',
        ...flags,
        '--entrypoint', command!, image, ...rest,
    ]
}

// Where the host has a path the agent sees, through the deepest bind mount holding it, or null. Volumes
// are left out: their host paths are Docker's own business.
export function hostPathOf(path: string, mounts: AgentMount[]): string | null {
    let best: AgentMount | null = null
    for (const mount of mounts) {
        if (mount.Type !== 'bind' || !isWithin(mount.Destination, path)) continue
        if (best === null || mount.Destination.length > best.Destination.length) best = mount
    }
    return best === null ? null : best.Source + path.slice(best.Destination.length)
}

export function createIoHelper(deps: { runner: Runner, container: string, newName?: () => string }): IoHelper {
    const newName = deps.newName ?? (() => `hostd-io-${randomBytes(4).toString('hex')}`)
    let own: { image: string, mounts: AgentMount[] } | null = null

    async function lookup(): Promise<{ image: string, mounts: AgentMount[] }> {
        if (own) return own
        const result = await deps.runner('docker', ['inspect', '--format', '{"image":{{json .Image}},"mounts":{{json .Mounts}}}', deps.container], INSPECT_TIMEOUT_MS)
        let parsed: { image?: unknown, mounts?: unknown } | null = null
        try {
            parsed = result.exitCode === 0 ? JSON.parse(result.stdout) : null
        } catch {
            parsed = null
        }
        if (!parsed || typeof parsed.image !== 'string' || !IMAGE_ID.test(parsed.image) || !Array.isArray(parsed.mounts)) {
            throw new Error(`${deps.container}'s image and mounts could not be read: ${tail(result.stderr.trim(), 300)}`)
        }
        own = { image: parsed.image, mounts: parsed.mounts as AgentMount[] }
        return own
    }

    return async (mounts, argv, timeoutMs) => {
        const { image, mounts: agentMounts } = await lookup()
        const translated = mounts.map(mount => {
            const source = mount.host ? mount.source : hostPathOf(mount.source, agentMounts)
            if (source === null) throw new Error(`${mount.source} is not on a folder ${deps.container} has from the host, so the helper cannot mount it`)
            return { source, target: mount.target, readOnly: mount.readOnly ?? false }
        })
        const name = newName()
        const result = await deps.runner('docker', helperArgv(image, name, translated, argv), timeoutMs)
        // --rm only removes a container that exits; one whose CLI was killed at the timeout is left behind
        if (result.timedOut || result.exitCode !== 0) await deps.runner('docker', ['rm', '-f', name], INSPECT_TIMEOUT_MS).catch(() => undefined)
        return result
    }
}

// What a helper answers when the folder it was given is not the one the agent checked: dockerd resolves a
// mount's source again when it makes the container, so a swap in between would mount something else
export const FOLDER_CHANGED = 97

// sqlite3's own .backup of /db/<database> into /stage/<copy>, once /db is proved to be the folder the
// agent resolved (device and inode, as identity() in the caller's fs reads them)
const SQLITE_BACKUP = `[ "$(stat -c %d:%i /db)" = "$1" ] || { echo "the folder changed" >&2; exit ${FOLDER_CHANGED}; }; exec sqlite3 "/db/$2" ".backup /stage/$3"`
export function sqliteBackupArgv(identity: string, database: string, copy: string): string[] {
    return ['sh', '-c', SQLITE_BACKUP, 'sh', identity, database, copy]
}

// One rename(2), exactly as the agent's own would be: it never follows a symlink at either end, and a
// failure prints its reason alone
const RENAME = `try { require('fs').renameSync(process.argv[1], process.argv[2]) } catch (error) { console.error(error.message); process.exit(1) }`
export function renameArgv(from: string, to: string): string[] {
    return ['node', '-e', RENAME, from, to]
}

// One folder made (never through an existing one: mkdir fails on anything already there) and owned and
// moded like the tree it goes in, as a deploy's carry does
const MKDIR = `try { const fs = require('fs'); const [dir, uid, gid, mode] = process.argv.slice(1); fs.mkdirSync(dir); fs.lchownSync(dir, +uid, +gid); fs.chmodSync(dir, +mode) } catch (error) { console.error(error.message); process.exit(1) }`
export function mkdirArgv(dir: string, like: { uid: number, gid: number, mode: number }): string[] {
    return ['node', '-e', MKDIR, dir, String(like.uid), String(like.gid), String(like.mode)]
}

// cp -a of /src to /stage/<name>, once /src is proved to be the folder the agent resolved. An identity
// of null skips that proof, for a folder the agent cannot see to check (a compose bind mount's host path
// outside what the agent has mounted).
const COPY_TREE = `[ -z "$1" ] || [ "$(stat -c %d:%i /src)" = "$1" ] || { echo "the folder changed" >&2; exit ${FOLDER_CHANGED}; }; exec cp -a /src "/stage/$2"`
export function copyTreeArgv(identity: string | null, name: string): string[] {
    return ['sh', '-c', COPY_TREE, 'sh', identity ?? '', name]
}
