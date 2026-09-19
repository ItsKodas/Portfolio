// Holds the registry over time. The first load throws so the boot gate can name the failure; every later
// reload is forgiving, because an operator mid-edit must never take a running service down.

import { readFile, stat } from 'node:fs/promises'
import { parseRegistry, RegistryError, type Registry } from './registry.ts'
import { describeError } from './formats.ts'

export type RegistryFs = {
    stat(path: string): Promise<{ mtimeMs: number, isFile(): boolean }>
    readFile(path: string): Promise<string>
}

const nodeFs: RegistryFs = {
    stat: path => stat(path),
    readFile: path => readFile(path, 'utf8'),
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
        // Compose creates a directory when a bind-mounted file does not exist yet, so this is the usual
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
        if (info.mtimeMs === this.loadedMtimeMs) return false
        // Recorded before parsing, so a rejected file is parsed once, not on every poll.
        this.loadedMtimeMs = info.mtimeMs
        try {
            if (!info.isFile()) throw new RegistryError([`${this.path} is not a file`])
            this.registry = parseRegistry(await this.fs.readFile(this.path))
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

    warnings(): string[] {
        return this.rejection ? [`registry reload rejected, still using the last good version: ${this.rejection}`] : []
    }
}
