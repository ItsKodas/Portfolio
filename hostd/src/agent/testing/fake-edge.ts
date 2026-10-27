// An EdgeClient for the agent's tests that runs edge's real host logic (edge/hosts.ts) over an in-memory
// NPM, so every domains test goes through the same ownership guard production does rather than a
// recorder that would accept anything. It does not import edge/server.ts: the dispatch below is the
// handful of lines that file's handleEdge is, minus the write queue a single test never needs.

import { EdgeUnavailableError, type EdgeClient } from '../edge-client.ts'
import { applyHosts, findHosts, getHosts, removeHosts, type HostsDeps } from '../../edge/hosts.ts'
import { FakeNpm } from '../../edge/testing/fake-npm.ts'
import type { EdgeReply, EdgeRequest } from '../../shared/edge-protocol.ts'

export const FAKE_UPSTREAM = '192.168.0.8'

// How the next call of a verb goes wrong: 'before' throws without touching NPM (edge never got it),
// 'after' does the work and then throws (the reply was lost, the case where the outcome is unknown).
type Failure = { verb: EdgeRequest['verb'], when: 'before' | 'after' }

export class FakeEdge implements EdgeClient {
    readonly npm: FakeNpm
    readonly requests: EdgeRequest[] = []
    private readonly deps: HostsDeps
    private readonly failures: Failure[] = []

    constructor(npm: FakeNpm = new FakeNpm()) {
        this.npm = npm
        this.deps = { npm, upstreamHost: FAKE_UPSTREAM }
    }

    failNext(verb: EdgeRequest['verb'], when: 'before' | 'after'): void {
        this.failures.push({ verb, when })
    }

    // The verbs that change something, for a test asserting nothing was written
    writes(): EdgeRequest[] {
        return this.requests.filter(request => request.verb === 'apply' || request.verb === 'remove')
    }

    async call(request: EdgeRequest): Promise<EdgeReply> {
        this.requests.push(structuredClone(request))
        const at = this.failures.findIndex(failure => failure.verb === request.verb)
        const failure = at === -1 ? null : this.failures.splice(at, 1)[0]!
        if (failure?.when === 'before') throw new EdgeUnavailableError('edge did not answer within 150 seconds')
        const reply = await this.handle(request)
        if (failure?.when === 'after') throw new EdgeUnavailableError('edge did not answer within 150 seconds')
        return structuredClone(reply)
    }

    private async handle(request: EdgeRequest): Promise<EdgeReply> {
        switch (request.verb) {
            case 'health': return { ok: true, verb: 'health', npmAge: 0 }
            case 'certificates': return { ok: true, verb: 'certificates', ids: await this.npm.certificateIds() }
            case 'find': return findHosts(this.deps, request.domains)
            case 'get': return getHosts(this.deps, request.owner, request.ids)
            case 'apply': return applyHosts(this.deps, request.owner, request.ids, request.spec, request.adopt)
            case 'remove': return removeHosts(this.deps, request.owner, request.ids)
        }
    }
}
