'use client'

// The log tab. It opens an EventSource on the portal's own relay, which derives the actor from the session
// and checks a client's ownership before hostd is asked, so nothing here sends a token or names a client:
// it names a project and a service and that is all.

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { LogPane } from '@/ui/LogPane/LogPane'
import styles from './site.module.css'

// What ui/LogPane takes. Its stream names are out and err, which are not hostd's, so the two are mapped
// rather than passed through.
type Line = { time: string, text: string, stream?: 'out' | 'err' }

// hostd's own line, read from hostd/src/shared/protocol.ts. ts is explicitly null when Docker gave no
// timestamp for the line, which is not the same as a line with no time.
type HostdLine = { stream: 'stdout' | 'stderr', ts: string | null, text: string, truncated: boolean }

type Status = 'connecting' | 'live' | 'reconnecting' | 'refused'

// A browser tab holding an unbounded array of log lines is a browser tab that eventually stops responding.
// hostd's own tail default is 200, so this is a generous ceiling on top of a live stream.
const MAX_LINES = 2000
const TAIL = 200
const RETRY_MS = 3000

function isHostdLine(value: unknown): value is HostdLine {
    if (!value || typeof value !== 'object') return false
    const line = value as Record<string, unknown>
    return typeof line.text === 'string' && (line.stream === 'stdout' || line.stream === 'stderr')
}

// The clock time, because a log is read against the wall. The date is dropped: every line on screen is
// from the last few minutes, and repeating today's date 200 times says nothing.
function clock(ts: string | null): string {
    if (!ts) return '--:--:--'
    const at = new Date(ts)
    return Number.isNaN(at.getTime()) ? ts : at.toTimeString().slice(0, 8)
}

export function SiteLogs({ id, services }: { id: string, services: string[] }) {
    const [service, setService] = useState(services[0] ?? '')
    const [lines, setLines] = useState<Line[]>([])
    const [status, setStatus] = useState<Status>('connecting')
    const [problem, setProblem] = useState<string | null>(null)
    // Bumped to reopen the stream by hand after a refusal, which is the only thing a Retry button does
    const [attempt, setAttempt] = useState(0)

    // hostd closes a follow stream after an hour and expects the reconnect to carry since. Kept in a ref
    // rather than state: reopening must read the latest value, not the one captured when the effect ran.
    const since = useRef<string | null>(null)

    useEffect(() => {
        if (!service) return

        let source: EventSource | null = null
        let timer: ReturnType<typeof setTimeout> | null = null
        let stopped = false
        let opened = false

        setLines([])
        setStatus('connecting')
        setProblem(null)
        since.current = null

        // A refusal arrives as an HTTP error before the stream ever opens, and EventSource does not hand
        // over the body. Asking for the same thing without following gets the relay's own refusal
        // document, which is already in the caller's language.
        async function explain(): Promise<string | null> {
            try {
                const response = await fetch(`/api/sites/${id}/logs?service=${encodeURIComponent(service)}&tail=1`, { cache: 'no-store' })
                if (response.ok) {
                    // It would work after all, so that was a dropped connection rather than a refusal
                    await response.body?.cancel()
                    return null
                }
                const body = await response.json() as { message?: unknown }
                return typeof body.message === 'string' ? body.message : 'The logs are not available.'
            } catch {
                return 'The logs are not available.'
            }
        }

        function later() {
            if (stopped) return
            setStatus('reconnecting')
            timer = setTimeout(open, RETRY_MS)
        }

        function open() {
            if (stopped) return
            const params = new URLSearchParams({ service, follow: '1', tail: String(TAIL) })
            // Only what arrived after the last line we already have, so a reconnect does not repeat the
            // screen. The relay passes it through and hostd takes Unix seconds or an RFC 3339 timestamp.
            if (since.current) params.set('since', since.current)

            const stream = new EventSource(`/api/sites/${id}/logs?${params}`)
            source = stream

            stream.onopen = () => {
                opened = true
                setStatus('live')
                setProblem(null)
            }

            stream.addEventListener('line', event => {
                const raw: unknown = JSON.parse((event as MessageEvent<string>).data)
                if (!isHostdLine(raw)) return
                if (raw.ts) since.current = raw.ts
                setLines(previous => {
                    const next = previous.concat({
                        time: clock(raw.ts),
                        text: raw.truncated ? `${raw.text} [truncated]` : raw.text,
                        stream: raw.stream === 'stderr' ? 'err' : 'out',
                    })
                    return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
                })
            })

            // hostd's own end event: the stream finished, which for a follow stream means the hour is up.
            // Reopening from the last timestamp is what it expects.
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

                if (fromHostd) {
                    setProblem('The log stream failed on the server. Reconnecting.')
                    return later()
                }

                // Never opened means the request was refused, not dropped: retrying on a loop would only
                // ask to be refused again, so it says so and waits to be asked.
                if (!opened) {
                    void explain().then(message => {
                        if (stopped) return
                        if (message === null) return later()
                        setProblem(message)
                        setStatus('refused')
                    })
                    return
                }

                later()
            })
        }

        open()

        // An unclosed stream per navigation is how a portal ends up holding four connections to one
        // container, which is hostd's documented limit.
        return () => {
            stopped = true
            if (timer) clearTimeout(timer)
            source?.close()
        }
    }, [id, service, attempt])

    if (!services.length) {
        return (
            <Callout tone="warn" title="No containers to follow">
                There is nothing to read the logs of until hostd can tell us what this site is running.
            </Callout>
        )
    }

    const said: Record<Status, string> = {
        connecting: 'Connecting.',
        live: 'Streaming. Newest at the bottom.',
        reconnecting: 'The stream closed. Picking it up again in a moment.',
        refused: 'Not streaming.',
    }

    return (
        <>
            <div className={styles.logHead}>
                {services.map(name => (
                    <Button
                        key={name}
                        size="small"
                        variant={name === service ? 'primary' : 'quiet'}
                        aria-pressed={name === service}
                        onClick={() => setService(name)}
                    >
                        {name}
                    </Button>
                ))}
                <span className={status === 'live' ? styles.state : styles.stateBad}>{said[status]}</span>
            </div>

            {status === 'refused' && problem && (
                <div className={styles.said}>
                    <Callout tone="crit" title="The logs did not open">
                        {problem}
                        <div className={styles.save}>
                            <Button size="small" onClick={() => setAttempt(count => count + 1)}>Try again</Button>
                        </div>
                    </Callout>
                </div>
            )}

            <LogPane lines={lines} label={`${service} logs`} following={status === 'live'} />
        </>
    )
}
