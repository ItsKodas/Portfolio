// What a deploy printed, for anybody who wants to watch it. One bounded buffer per environment, with
// whoever is subscribed to that environment right now.
//
// The buffer is what makes attaching mid-deploy work at all: a watcher arriving late gets everything so
// far replayed, then live events, so a reload during a build and a deploy the poller started an hour
// after anybody last looked both behave the same way. It is bounded because most deploys are started by
// the poller with nobody watching, and an unwatched deploy must cost a fixed amount.
//
// Deliberately in memory only. An agent restart kills the deploy it belonged to as well (a deploy is an
// in-process promise), so a buffer that outlived the process would only describe something that is no
// longer happening. The deploy history remains the durable record.

import { MAX_WATCH_BYTES, type DeployEvent } from '../shared/deploys.ts'

type Buffered = { startedAt: string, events: DeployEvent[], bytes: number }

export class DeployWatch {
    private readonly buffers = new Map<string, Buffered>()
    private readonly listeners = new Map<string, Set<(event: DeployEvent) => void>>()

    constructor(private readonly now: () => number, private readonly maxBytes: number = MAX_WATCH_BYTES) {}

    // Clears whatever the previous deploy left. Called once per deploy, before anything else for it.
    begin(key: string, startedAt: string): void {
        this.buffers.set(key, { startedAt, events: [], bytes: 0 })
    }

    step(key: string, text: string): void {
        this.add(key, 'step', text)
    }

    output(key: string, text: string): void {
        this.add(key, 'output', text)
    }

    end(key: string, text: string): void {
        this.add(key, 'end', text)
    }

    replay(key: string): DeployEvent[] {
        return [...(this.buffers.get(key)?.events ?? [])]
    }

    subscribe(key: string, listener: (event: DeployEvent) => void): () => void {
        const set = this.listeners.get(key) ?? new Set()
        set.add(listener)
        this.listeners.set(key, set)
        return () => {
            const current = this.listeners.get(key)
            if (!current) return
            current.delete(listener)
            if (current.size === 0) this.listeners.delete(key)
        }
    }

    private add(key: string, kind: DeployEvent['kind'], text: string): void {
        const buffered = this.buffers.get(key)
        // No deploy has begun for this key. Not a reason to throw into the middle of one.
        if (!buffered) return

        const event: DeployEvent = { at: new Date(this.now()).toISOString(), startedAt: buffered.startedAt, kind, text }
        buffered.events.push(event)
        buffered.bytes += Buffer.byteLength(text)
        while (buffered.bytes > this.maxBytes && buffered.events.length > 1) {
            const dropped = buffered.events.shift()
            buffered.bytes -= Buffer.byteLength(dropped?.text ?? '')
        }

        // A listener that throws is a bug in that listener, and must not take the deploy down with it.
        for (const listener of this.listeners.get(key) ?? []) {
            try {
                listener(event)
            } catch {
                // Nothing to do here: the deploy is what matters, and it is not this listener's business.
            }
        }
    }
}
