// What an adopted NPM proxy host looked like before hostd took it over, kept so the adoption can be
// undone: one small JSON file per environment under the agent's state volume. It is the NPM
// counterpart of the adopted-vhost backup the Apache design kept, and nothing else reads it.
//
// A file that cannot be understood reads as no record at all. The undo then refuses rather than
// writing half a host back, which is the safe direction: Koda can still put the host back by hand.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

import { parseEdgeReply, type Owner, type PreviousHosts } from '../shared/edge-protocol.ts'
import type { NpmIds } from '../shared/registry.ts'

export type AdoptedRecord = { ids: NpmIds, previous: PreviousHosts }

export type AdoptedStore = {
    save(owner: Owner, record: AdoptedRecord): Promise<void>
    read(owner: Owner): Promise<AdoptedRecord | null>
    clear(owner: Owner): Promise<void>
}

export const ADOPTED_DIR = '/var/lib/hostd/adopted'

// The record is exactly the ids and previous of an apply reply, so edge-protocol's own strict parser
// checks it rather than a second copy of the same rules living here.
function parseRecord(text: string): AdoptedRecord | null {
    let value: unknown
    try {
        value = JSON.parse(text)
    } catch {
        return null
    }
    if (typeof value !== 'object' || value === null) return null
    const { ids, previous } = value as Record<string, unknown>
    const parsed = parseEdgeReply({ ok: true, verb: 'apply', ids, previous })
    if (!parsed || !parsed.ok || parsed.verb !== 'apply' || parsed.previous === null) return null
    return { ids: parsed.ids, previous: parsed.previous }
}

export function adoptedStore(dir: string = ADOPTED_DIR): AdoptedStore {
    // Owner names are a project id and an environment name, both already restricted to [a-z0-9-], so
    // the joined name cannot leave the directory.
    const pathOf = (owner: Owner) => posix.join(dir.replace(/\\/g, '/'), `${owner.project}-${owner.environment}.json`)

    return {
        async save(owner, record) {
            await mkdir(dir, { recursive: true })
            // Written beside and renamed over, so a crash part-way never leaves a truncated record
            const path = pathOf(owner)
            const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
            await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
            await rename(temporary, path)
        },
        async read(owner) {
            let text: string
            try {
                text = await readFile(pathOf(owner), 'utf8')
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
                throw error
            }
            return parseRecord(text)
        },
        async clear(owner) {
            await rm(pathOf(owner), { force: true })
        },
    }
}
