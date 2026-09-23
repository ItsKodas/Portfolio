'use client'

// The live deploy column. One stream per environment, not per deploy: it is a tail of this
// environment's deploy activity, so the poller starting the next one needs no reconnection and a reload
// mid-deploy picks up where it was. startedAt changing is the boundary between one deploy and the next.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/ui/Button/Button'
import styles from './site.module.css'

// The same ceiling the container log view keeps, for the same reason.
export const MAX_LINES = 2000

// The same wait the container log view leaves between attempts, for the same reason: soon enough to pick
// a deploy back up, slow enough that a stream which keeps dropping is not a request every second.
const RETRY_MS = 3000

const DROPPED = 'The stream dropped. Picking it up again in a moment.'

type Event = { at: string, startedAt: string, kind: 'step' | 'output' | 'end', text: string }

function isEvent(value: unknown): value is Event {
    if (typeof value !== 'object' || value === null) return false
    const raw = value as Record<string, unknown>
    return typeof raw.text === 'string' && typeof raw.startedAt === 'string'
        && (raw.kind === 'step' || raw.kind === 'output' || raw.kind === 'end')
}

export function DeployLog({ id, environment }: { id: string, environment: 'live' | 'test' }) {
    const [lines, setLines] = useState<Event[]>([])
    const [problem, setProblem] = useState<string | null>(null)
    const [dropped, setDropped] = useState(false)
    // Bumped to reopen the stream by hand after a refusal, which is the only thing Try again does
    const [attempt, setAttempt] = useState(0)
    const startedAt = useRef<string | null>(null)
    const router = useRouter()

    useEffect(() => {
        let stopped = false
        const sources: EventSource[] = []
        const timers: Array<ReturnType<typeof setTimeout>> = []
        const url = `/api/sites/${encodeURIComponent(id)}/deploy?environment=${environment}`

        // Every path here closes the stream before deciding what to do next, so the retrying is this
        // component's rather than EventSource's. EventSource retries a closed connection on its own
        // schedule and cannot be told to stop, which behind a refusal is one request to hostd and one
        // audit line every few seconds for as long as the tab is open.
        function later() {
            if (stopped) return
            setDropped(true)
            timers.push(setTimeout(open, RETRY_MS))
        }

        function open() {
            if (stopped) return
            // Never opened means the error arrived before any line did, which is what a refused request
            // looks like from here; opened-then-error is a connection that dropped.
            let opened = false
            const stream = new EventSource(url)
            sources.push(stream)

            stream.onopen = () => {
                opened = true
                if (stopped) return
                setProblem(null)
                setDropped(false)
                // hostd replays its whole buffer to every new subscriber, including a reconnect after a
                // dropped connection. Without this, the replayed lines carry the same startedAt as what is
                // already on screen and get appended again instead of read as a repeat of it.
                startedAt.current = null
            }

            stream.addEventListener('line', event => {
                const raw: unknown = JSON.parse((event as MessageEvent<string>).data)
                if (!isEvent(raw) || stopped) return
                setLines(previous => {
                    // A different deploy: replace rather than append, so one deploy's output never reads as
                    // the tail of the one before it.
                    const base = raw.startedAt === startedAt.current ? previous : []
                    startedAt.current = raw.startedAt
                    const next = [...base, raw]
                    return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
                })
                // The history row is written when the deploy ends, so this is when it becomes worth re-reading.
                if (raw.kind === 'end') router.refresh()
            })

            // api's own end event: the stream is over at its end, which mid-deploy means the agent went
            // away and took the deploy and the buffer with it. Saying so is the obligation the buffer
            // brings: a half-log with nothing arriving and nothing said reads as a deploy still running.
            stream.addEventListener('end', () => {
                stream.close()
                later()
            })

            // Two different things arrive here. hostd sends a named error event, which is a message and
            // carries data; the browser fires a plain error event when the connection itself fails, which
            // does not. Telling them apart is what decides whether this is worth retrying.
            stream.addEventListener('error', event => {
                const fromHostd = 'data' in event
                stream.close()
                if (stopped) return
                if (fromHostd || opened) return later()

                // EventSource does not hand over the body of an HTTP error, so ask plainly for the message.
                void fetch(url, { cache: 'no-store' }).then(async response => {
                    if (stopped) return
                    if (response.ok) {
                        // It would work after all, so that was a dropped connection rather than a refusal
                        await response.body?.cancel()
                        return later()
                    }
                    const body = await response.json().catch(() => ({})) as { message?: unknown }
                    setProblem(typeof body.message === 'string' ? body.message : 'This deploy cannot be watched.')
                }).catch(() => {
                    if (!stopped) setProblem('This deploy cannot be watched.')
                })
            })
        }

        open()

        return () => {
            stopped = true
            for (const timer of timers) clearTimeout(timer)
            for (const source of sources) source.close()
        }
    }, [id, environment, router, attempt])

    return (
        <aside className={styles.deployLog} aria-label="Deploy output">
            {problem && (
                <>
                    <p className={styles.deployLogProblem}>{problem}</p>
                    <div className={styles.deployLogRetry}>
                        <Button size="small" onClick={() => setAttempt(count => count + 1)}>Try again</Button>
                    </div>
                </>
            )}
            {!problem && lines.length === 0 && !dropped && <p className={styles.deployLogIdle}>Nothing has deployed yet.</p>}
            <ol className={styles.deployLogLines}>
                {lines.map((line, index) => (
                    <li key={`${line.at}-${index}`} className={styles[line.kind]}>{line.text}</li>
                ))}
            </ol>
            {/* Under the lines rather than over them, because it is where the output stopped. */}
            {!problem && dropped && <p className={styles.deployLogProblem}>{DROPPED}</p>}
        </aside>
    )
}
