// Holds the registry over time. The first load throws so the boot gate can name the failure; every later
// reload is forgiving, because an operator mid-edit must never take a running service down.

import { readFile, stat } from 'node:fs/promises'
import { parseRegistry, RegistryError, type Registry } from './registry.ts'
import { describeError } from './formats.ts'

export type RegistryFs = {
    stat(path: string): Promise<{ mtimeMs: number, nlink: number, isFile(): boolean }>
    readFile(path: string): Promise<string>
}

const nodeFs: RegistryFs = {
    stat: path => stat(path),
    readFile: path => readFile(path, 'utf8'),
}

// A file with no links left is one that was replaced on the host while this process held it open. That
// is what an editor, or sed -i, does to a file bind-mounted into a container one file at a time: the
// mount keeps resolving to the old inode, so the contents freeze and the modification time never moves
// again. Nothing else here would notice, which is the whole danger: hostd would look healthy while
// serving a registry the operator believes they have already changed. The compose file mounts the
// registry's directory rather than the file itself so this cannot happen, and this check is what says
// so out loud if anything ever puts the old arrangement back.
function detachedMessage(path: string): string {
    return `${path} has been replaced on the host and this process is reading a deleted copy, so no edit to it can take effect: recreate the containers with docker compose up -d --force-recreate`
}

export function explainRegistryError(error: unknown): string {
    return error instanceof RegistryError ? error.failures.join('; ') : describeError(error)
}

export class RegistryStore {
    private registry: Registry | null = null
    private loadedMtimeMs = -1
    private rejection: string | null = null

    constructor(private readonly path: string, private readonly fs: RegistryFs = nodeFs) {}

    async load(): Promise<Registry> {
        const info = await this.fs.stat(this.path)
        if (info.nlink === 0) throw new RegistryError([detachedMessage(this.path)])
        // Compose creates a directory when a bind-mounted path does not exist yet, so this is the usual
        // first-run mistake, and the message says how it happened.
        if (!info.isFile()) {
            throw new RegistryError([`${this.path} is not a file (was projects.yaml created before the first docker compose up?)`])
        }
        const registry = parseRegistry(await this.fs.readFile(this.path))
        this.registry = registry
        this.loadedMtimeMs = info.mtimeMs
        this.rejection = null
        return registry
    }

    async refresh(): Promise<boolean> {
        let info
        try {
            info = await this.fs.stat(this.path)
        } catch (error) {
            this.rejection = explainRegistryError(error)
            // Forget the mtime, so the file is re-read when it reappears even if its mtime did not change.
            this.loadedMtimeMs = -1
            return false
        }
        // Before the modification time is consulted, because a replaced file's never moves again.
        if (info.nlink === 0) {
            this.rejection = detachedMessage(this.path)
            // Forget the mtime, so a mount pointing at a live file again is re-read whatever its mtime.
            this.loadedMtimeMs = -1
            return false
        }
        if (info.mtimeMs === this.loadedMtimeMs) return false

        // A file that cannot be read at all (not a file where one should be, or readFile itself
        // throwing, EACCES most realistically) was never actually examined, so this must not adopt the
        // mtime the way a parse failure deliberately does below: the mtime is left exactly as it was,
        // so the next poll tries the read again even though nothing about the file has moved since.
        // This is the shape of the bug found on the live dedi: registry-write.ts's writer left the
        // registry unreadable to api after replacing it, the read's EACCES was folded into the same
        // "recorded before parsing" branch a parse failure uses, and the mtime that move consumed was
        // never seen again, so hostd did not retry until a container restart forced a fresh read. A read
        // failure and a parse failure are different problems, and now take different paths.
        let text: string
        try {
            if (!info.isFile()) throw new RegistryError([`${this.path} is not a file`])
            text = await this.fs.readFile(this.path)
        } catch (error) {
            this.rejection = explainRegistryError(error)
            return false
        }

        // Recorded only now, after a successful read, and before parsing: a file that goes on to fail to
        // *parse* is parsed once, not on every poll, because content that is wrong now will still be
        // wrong next poll unless the mtime moves again.
        this.loadedMtimeMs = info.mtimeMs
        try {
            this.registry = parseRegistry(text)
            this.rejection = null
            return true
        } catch (error) {
            this.rejection = explainRegistryError(error)
            return false
        }
    }

    current(): Registry {
        if (!this.registry) throw new Error('the registry has not been loaded')
        return this.registry
    }

    // Why the last reload was rejected, or null once the file on disk is the one in use
    rejected(): string | null {
        return this.rejection
    }

    warnings(): string[] {
        return this.rejection ? [`registry reload rejected, still using the last good version: ${this.rejection}`] : []
    }
}
