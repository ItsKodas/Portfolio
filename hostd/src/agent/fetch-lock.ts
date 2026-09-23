// One git command at a time per repository. A nested site's environments share one repository, so a
// live deploy and a test deploy running together would otherwise collide on git's own lock files (a
// fetch updating refs while a worktree add reads them). Keyed by the request's dir, which is the
// repository for every verb that has one; a verb without a dir (branches, credentials) passes straight
// through. Flat repositories are locked the same way, which costs nothing, since one flat repository
// only ever had one environment using it.

import type { FetchClient } from './fetch-client.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

export function serialisePerRepo(client: FetchClient): FetchClient {
    const tails = new Map<string, Promise<unknown>>()
    return {
        call(request: FetchRequest): Promise<FetchReply> {
            if (!('dir' in request)) return client.call(request)
            const key = request.dir
            const before = tails.get(key) ?? Promise.resolve()
            const run = before.catch(() => {}).then(() => client.call(request))
            const tail = run.catch(() => {})
            tails.set(key, tail)
            void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
            return run
        },
    }
}
