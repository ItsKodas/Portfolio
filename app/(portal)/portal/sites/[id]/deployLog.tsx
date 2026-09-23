'use client'

// The live deploy column. One stream per environment, not per deploy: it is a tail of this
// environment's deploy activity, so the poller starting the next one needs no reconnection and a reload
// mid-deploy picks up where it was. startedAt changing is the boundary between one deploy and the next.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import styles from './site.module.css'

// The same ceiling the container log view keeps, for the same reason.
export const MAX_LINES = 2000

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
    const startedAt = useRef<string | null>(null)
    const router = useRouter()

    useEffect(() => {
        let stopped = false
        // Never opened means the error arrived before any line did, which is what a refused request
        // looks like from here; opened-then-error is a dropped connection EventSource is about to retry
        // on its own.
        let opened = false
        const url = `/api/sites/${id}/deploy?environment=${environment}`
        const stream = new EventSource(url)

        stream.onopen = () => {
            opened = true
            if (stopped) return
            setProblem(null)
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

        stream.onerror = () => {
            if (stopped || opened) return
            // EventSource does not hand over the body of an HTTP error, so ask plainly for the message.
            void fetch(url, { cache: 'no-store' }).then(async response => {
                if (stopped) return
                if (response.ok) {
                    await response.body?.cancel()
                    return
                }
                const body = await response.json().catch(() => ({})) as { message?: unknown }
                setProblem(typeof body.message === 'string' ? body.message : 'This deploy cannot be watched.')
            }).catch(() => {
                if (!stopped) setProblem('This deploy cannot be watched.')
            })
        }

        return () => {
            stopped = true
            stream.close()
        }
    }, [id, environment, router])

    return (
        <aside className={styles.deployLog} aria-label="Deploy output">
            {problem && <p className={styles.deployLogProblem}>{problem}</p>}
            {!problem && lines.length === 0 && <p className={styles.deployLogIdle}>Nothing has deployed yet.</p>}
            <ol className={styles.deployLogLines}>
                {lines.map((line, index) => (
                    <li key={`${line.at}-${index}`} className={styles[line.kind]}>{line.text}</li>
                ))}
            </ol>
        </aside>
    )
}
