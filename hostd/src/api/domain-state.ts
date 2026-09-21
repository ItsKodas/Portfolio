// What api knows about each hostname, which is everything the registry does not: whether it has been
// proved to reach this site, when that was last checked, and what went wrong if it did not.
//
// It lives here rather than in the registry because it changes every minute and the registry is
// hand-edited and polled every ten seconds. Writing verification state into a file the operator has open
// in an editor would lose one or the other.

import { dirname } from 'node:path'
import { hostnamesOf, type EnvironmentName, type Registry } from '../shared/registry.ts'

export const DOMAIN_STATES = ['unmanaged', 'pending', 'active', 'failed', 'broken'] as const
export type DomainState = typeof DOMAIN_STATES[number]

export type DomainRecord = {
    project: string
    environment: EnvironmentName
    hostname: string
    primary: boolean
    state: DomainState
    token: string | null
    checkedAt: string | null
    attempts: number
    firstSeenAt: string
    error: string | null
    vhost: { ok: boolean, output: string } | null
}

export type DomainStateFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(path: string, options: { recursive: true }): Promise<unknown>
}

export function domainKey(project: string, environment: EnvironmentName, hostname: string): string {
    return `${project}:${environment}:${hostname}`
}

export function newRecord(
    project: string,
    environment: EnvironmentName,
    hostname: string,
    primary: boolean,
    now: string,
): DomainRecord {
    // unmanaged, not pending: a record exists the moment the registry names a hostname, and at that
    // point hostd has written no vhost for it and proved nothing about it. Starting it pending would
    // put every one of the five existing sites into a 72 hour countdown it was never going to win.
    return {
        project, environment, hostname, primary,
        state: 'unmanaged', token: null, checkedAt: null, attempts: 0,
        firstSeenAt: now, error: null, vhost: null,
    }
}

export class DomainStore {
    private records = new Map<string, DomainRecord>()

    constructor(private readonly path: string, private readonly fs: DomainStateFs) {}

    async load(): Promise<void> {
        try {
            const parsed = JSON.parse(await this.fs.readFile(this.path)) as DomainRecord[]
            this.records = new Map(parsed.map(record => [domainKey(record.project, record.environment, record.hostname), record]))
        } catch {
            // No file yet, or one that will not parse. Either way there is nothing to resume from, and
            // reconcile is about to rebuild an unmanaged record for every hostname the registry names.
            this.records = new Map()
        }
    }

    get(key: string): DomainRecord | undefined {
        return this.records.get(key)
    }

    all(): DomainRecord[] {
        return [...this.records.values()]
    }

    // The primary first, then by name. Sorted here rather than in the page so the table cannot reorder
    // itself between two renders of the same data.
    forEnvironment(project: string, environment: EnvironmentName): DomainRecord[] {
        return this.all()
            .filter(record => record.project === project && record.environment === environment)
            .sort((a, b) => (Number(b.primary) - Number(a.primary)) || a.hostname.localeCompare(b.hostname))
    }

    async put(record: DomainRecord): Promise<void> {
        this.records.set(domainKey(record.project, record.environment, record.hostname), record)
        await this.write()
    }

    async remove(key: string): Promise<void> {
        if (this.records.delete(key)) await this.write()
    }

    // Brings the store level with the registry: a record for every hostname the registry names, and none
    // for a hostname it no longer does.
    //
    // An existing record is never touched, and that is the whole point. The registry is re-read every ten
    // seconds, so anything this wrote to a live record would be written six times a minute: a pending
    // domain would have its clock reset before it could ever reach 72 hours, and an active one would
    // forget it had been checked.
    async reconcile(registry: Registry, now: string): Promise<void> {
        const wanted = new Map<string, DomainRecord>()
        for (const project of registry.projects.values()) {
            if (!project.capabilities.has('domains')) continue
            for (const environment of project.environments.values()) {
                const hostnames = hostnamesOf(environment)
                for (const hostname of hostnames) {
                    const primary = hostname === environment.domain
                    wanted.set(
                        domainKey(project.id, environment.name, hostname),
                        newRecord(project.id, environment.name, hostname, primary, now),
                    )
                }
            }
        }

        let changed = false
        for (const [key, fresh] of wanted) {
            if (this.records.has(key)) continue
            this.records.set(key, fresh)
            changed = true
        }
        for (const key of [...this.records.keys()]) {
            if (wanted.has(key)) continue
            this.records.delete(key)
            changed = true
        }
        if (changed) await this.write()
    }

    // Written whole and renamed into place: a torn file here would lose every domain's verification
    // state at once, and the whole file is a few kilobytes.
    private async write(): Promise<void> {
        await this.fs.mkdir(dirname(this.path), { recursive: true })
        const staging = `${this.path}.tmp`
        await this.fs.writeFile(staging, JSON.stringify(this.all(), null, 2))
        await this.fs.rename(staging, this.path)
    }
}
