'use client'

// The log view, on the Overview and on its own tab. It opens an EventSource per container on the portal's
// own relay, which derives the actor from the session and checks a client's ownership before hostd is
// asked, so nothing here sends a token or names a client: it names a project and a service and that is all.
//
// One stream per container, because hostd's logs call takes one service (hostd/src/shared/protocol.ts,
// LogsArgs). The filter decides which of them are open: a container nobody is looking at is a connection
// nobody is paying for, and hostd allows only four followers per container.

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { LogPane } from '@/ui/LogPane/LogPane'
import { useSettling } from './settling'
import styles from './site.module.css'

// What ui/LogPane takes, plus the instant the line was written. The instant is for ordering and never
// drawn: `time` is the clock face, which several different instants share.
type Feed = {
    time: string
    text: string
    stream?: 'out' | 'err'
    source?: string
    at: number | null
}

// hostd's own line, read from hostd/src/shared/protocol.ts. ts is explicitly null when Docker gave no
// timestamp for the line, which is not the same as a line with no time.
type HostdLine = { stream: 'stdout' | 'stderr', ts: string | null, text: string, truncated: boolean }

// ended is a follow stream that closed again without a single new line, which is what hostd does for a
// container that is not running: it sends the tail and stops, because there is nothing to follow.
type Status = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'refused'

// A browser tab holding an unbounded array of log lines is a browser tab that eventually stops responding.
// hostd's own tail default is 200, so this is a generous ceiling on top of a live stream.
const MAX_LINES = 2000
const TAIL = 200
const RETRY_MS = 3000
// How far apart the tries get for a container that keeps answering with nothing new. A stopped site is
// asked again now and then rather than every three seconds for as long as the tab is open, and pressing
// Start brings the next try forward rather than waiting this out.
const QUIET_MAX_MS = 30000
// A follow stream that ends this soon after opening was never following anything
const ENDED_WITHIN_MS = 10000

// How far back an arriving line may be slotted in. Each stream sends its tail in one burst when it opens,
// so two containers' first two hundred lines arrive as one container's block and then the other's. Placed
// by their timestamps instead, the first screen reads as what actually happened, in order. The window is
// bounded because this runs for every line of a live stream.
const REORDER = 400

// What the line beside the filter says instead of counting streams, while the containers are being taken
// away or brought back. Neither of these is a problem, so neither is coloured as one.
const COMING_BACK = 'Waiting for the containers to come back.'
const GOING_AWAY = 'Stopping. The streams close with the containers.'

// Joins a list of container names into one value a hook can compare. A newline, because a compose service
// name cannot contain one and a comma or a space is not worth betting on.
const SEPARATOR = '\n'

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

function instant(ts: string | null): number | null {
    if (!ts) return null
    const at = new Date(ts).getTime()
    return Number.isNaN(at) ? null : at
}

// Newest at the bottom, and a line that happened earlier goes above the ones it happened before, as far
// back as the window allows. A line with no timestamp has nothing to sort on and goes at the end.
export function place(lines: Feed[], line: Feed): Feed[] {
    if (line.at === null || !lines.length) return lines.concat(line)

    let at = lines.length
    const floor = Math.max(0, lines.length - REORDER)
    while (at > floor) {
        const before = lines[at - 1]
        if (before.at === null || before.at <= line.at) break
        at--
    }

    return at === lines.length ? lines.concat(line) : lines.slice(0, at).concat(line, lines.slice(at))
}

// What the line beside the filter says. Several streams can be in different states at once, and the one
// sentence over them has to be true of all of them rather than of the first one checked.
export function summarise(states: Status[]): { text: string, bad: boolean } {
    if (!states.length) return { text: 'Choose a container to follow.', bad: true }
    const live = states.filter(state => state === 'live').length
    const ended = states.filter(state => state === 'ended').length
    if (live === states.length) return { text: 'Streaming. Newest at the bottom.', bad: false }
    // A container that is not running has nothing to stream, which is a fact about the site rather than
    // a fault in the log. The page above already says whether that is a problem.
    if (ended === states.length) return { text: 'Not running. These are its last lines.', bad: false }
    if (live + ended === states.length) return { text: `Streaming ${live} of ${states.length}. The rest are not running.`, bad: false }
    if (live) return { text: `Streaming ${live} of ${states.length}.`, bad: true }
    if (states.some(state => state === 'refused')) return { text: 'Not streaming.', bad: true }
    if (states.some(state => state === 'reconnecting')) return { text: 'The stream closed. Picking it up again in a moment.', bad: true }
    return { text: 'Connecting.', bad: true }
}

export function SiteLogs({ id, services }: { id: string, services: string[] }) {
    // Everything, to begin with: a site with one container is the common case, and a filter that starts
    // with something already hidden is a filter that hides a container nobody asked it to.
    const [chosen, setChosen] = useState<string[]>(services)
    const [lines, setLines] = useState<Feed[]>([])
    const [states, setStates] = useState<Record<string, Status>>({})
    const [problems, setProblems] = useState<Record<string, string>>({})
    // Bumped to reopen the streams by hand after a refusal, which is the only thing Try again does
    const [attempt, setAttempt] = useState(0)

    // Whether the operator has asked the site to do something and it has not finished. While they have,
    // a container that is not there is the middle of that rather than news.
    const { settling } = useSettling()
    const waiting = settling ? (settling.action === 'stop' ? GOING_AWAY : COMING_BACK) : null

    // Read inside the stream handlers rather than closed over by the effect below. Closing over it would
    // put it in that effect's dependencies, and the streams would be torn down and the pane emptied the
    // moment somebody pressed Restart, which is the one moment the log is worth reading.
    const settlingRef = useRef(false)
    // A stream waiting out a long gap before asking again, by container. Something starting is the moment
    // to stop waiting: the container it was waiting on is on its way back.
    const wakers = useRef(new Set<() => void>())
    useEffect(() => {
        settlingRef.current = settling !== null
        if (settling) for (const wake of wakers.current) wake()
    }, [settling])

    // The containers can change underneath this: starting a stopped site gives it the containers it had
    // none of a moment ago, and the page refreshes rather than remounting. A selection made against the
    // old list would then be a filter over names that no longer exist, or an empty one that hides
    // everything. Adjusting it here rather than in an effect means the first render after the change is
    // already right, with no pass where the pane is empty for no reason.
    const all = services.join(SEPARATOR)
    const [known, setKnown] = useState(all)
    if (known !== all) {
        setKnown(all)
        setChosen(services)
    }

    // The selection as one value, so the effect below reopens when it changes and not when the array is
    // merely rebuilt. Changing it starts over: each stream sends its tail again when it opens, and a
    // buffer kept across that would show the last two hundred lines twice.
    const key = chosen.join(SEPARATOR)

    useEffect(() => {
        const wanted = key ? key.split(SEPARATOR) : []

        setLines([])
        setProblems({})
        setStates(Object.fromEntries(wanted.map(service => [service, 'connecting' as Status])))
        if (!wanted.length) return

        let stopped = false
        const sources: EventSource[] = []
        const timers: Array<ReturnType<typeof setTimeout>> = []
        const cleanups: Array<() => void> = []

        function follow(service: string) {
            // hostd closes a follow stream after an hour and expects the reconnect to carry since. Per
            // stream, because the streams do not close together.
            let since: string | null = null
            let opened = false

            // What has already been drawn at the newest instant this stream has reached. hostd's since
            // is inclusive, and Docker's nanoseconds are cut to milliseconds on the way there, so every
            // reconnect hands back at least the last line again. A stopped container ends its follow
            // stream the moment it opens, and reconnecting every few seconds repeated its last lines
            // down the pane for as long as the tab stayed open.
            let edge: number | null = null
            let atEdge = new Map<string, number>()
            // The same, for the connection that is open now: whatever of it has not been seen again yet
            let replay = new Map<string, number>()
            let replaying = false
            // Whether this connection brought anything new, and how many in a row have not
            let fresh = false
            let began = 0
            let quiet = 0
            let timer: ReturnType<typeof setTimeout> | null = null

            function wake() {
                if (stopped || timer === null) return
                clearTimeout(timer)
                timer = null
                quiet = 0
                open()
            }
            wakers.current.add(wake)
            cleanups.push(() => wakers.current.delete(wake))

            // True for a line this stream has already drawn, which only a reconnect sends
            function seen(at: number | null, key: string): boolean {
                if (!replaying || at === null || edge === null) return false
                if (at < edge) return true
                const left = at === edge ? replay.get(key) ?? 0 : 0
                if (left > 0) {
                    replay.set(key, left - 1)
                    return true
                }
                // The first line past what was already there, and everything after it is new
                replaying = false
                return false
            }

            function remember(at: number | null, key: string) {
                if (at === null) return
                if (edge === null || at > edge) {
                    edge = at
                    atEdge = new Map([[key, 1]])
                } else if (at === edge) {
                    atEdge.set(key, (atEdge.get(key) ?? 0) + 1)
                }
            }

            function say(status: Status) {
                if (!stopped) setStates(previous => ({ ...previous, [service]: status }))
            }

            // A refusal arrives as an HTTP error before the stream ever opens, and EventSource does not
            // hand over the body. Asking for the same thing without following gets the relay's own
            // refusal document, which is already in the caller's language.
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

            function later(status: Status = 'reconnecting') {
                if (stopped) return
                say(status)
                // Mid-operation the container is expected back any moment, so it is asked for promptly
                const wait = settlingRef.current ? RETRY_MS : Math.min(RETRY_MS * 2 ** quiet, QUIET_MAX_MS)
                timer = setTimeout(() => {
                    timer = null
                    open()
                }, wait)
                timers.push(timer)
            }

            function open() {
                if (stopped) return
                fresh = false
                began = Date.now()
                replaying = edge !== null
                replay = new Map(atEdge)
                const params = new URLSearchParams({ service, follow: '1', tail: String(TAIL) })
                // Only what arrived after the last line we already have, so a reconnect does not repeat
                // the screen. The relay passes it through and hostd takes Unix seconds or RFC 3339.
                if (since) params.set('since', since)

                const stream = new EventSource(`/api/sites/${id}/logs?${params}`)
                sources.push(stream)

                stream.onopen = () => {
                    opened = true
                    say('live')
                    if (!stopped) setProblems(previous => {
                        if (!(service in previous)) return previous
                        const next = { ...previous }
                        delete next[service]
                        return next
                    })
                }

                stream.addEventListener('line', event => {
                    const raw: unknown = JSON.parse((event as MessageEvent<string>).data)
                    if (!isHostdLine(raw)) return
                    const at = instant(raw.ts)
                    const key = `${raw.stream}\u0000${raw.text}`
                    if (seen(at, key)) return
                    remember(at, key)
                    fresh = true
                    if (raw.ts) since = raw.ts
                    if (stopped) return
                    setLines(previous => {
                        const next = place(previous, {
                            time: clock(raw.ts),
                            text: raw.truncated ? `${raw.text} [truncated]` : raw.text,
                            stream: raw.stream === 'stderr' ? 'err' : 'out',
                            // Only worth a column when there is more than one of them
                            source: wanted.length > 1 ? service : undefined,
                            at,
                        })
                        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
                    })
                })

                // hostd's own end event: the stream finished, which for a follow stream means the hour is
                // up. Reopening from the last timestamp is what it expects.
                // One that ends straight away with nothing new is a container that is not running, which
                // gets asked again less and less often rather than every few seconds. A quiet hour on a
                // running one ends with nothing new as well, and is only the hour being up.
                stream.addEventListener('end', () => {
                    stream.close()
                    const idle = !fresh && Date.now() - began < ENDED_WITHIN_MS
                    quiet = idle ? quiet + 1 : 0
                    later(idle ? 'ended' : 'reconnecting')
                })

                // Two different things arrive here. hostd sends a named error event, which is a message
                // and carries data; the browser fires a plain error event when the connection itself
                // fails, which does not. Telling them apart is what decides whether this is worth retrying.
                stream.addEventListener('error', event => {
                    const fromHostd = 'data' in event
                    stream.close()
                    if (stopped) return

                    if (fromHostd) {
                        setProblems(previous => ({ ...previous, [service]: 'The log stream failed on the server. Reconnecting.' }))
                        return later()
                    }

                    // Never opened means the request was refused, not dropped: retrying on a loop would
                    // only ask to be refused again, so it says so and waits to be asked. Unless the site
                    // is mid-operation, where the refusal is a container that is not back yet and the
                    // thing to do about it is exactly to ask again in a moment.
                    if (!opened && settlingRef.current) return later()

                    if (!opened) {
                        void explain().then(message => {
                            if (stopped) return
                            if (message === null) return later()
                            setProblems(previous => ({ ...previous, [service]: message }))
                            say('refused')
                        })
                        return
                    }

                    later()
                })
            }

            open()
        }

        for (const service of wanted) follow(service)

        // An unclosed stream per navigation is how a portal ends up holding four connections to one
        // container, which is hostd's documented limit.
        return () => {
            stopped = true
            for (const timer of timers) clearTimeout(timer)
            for (const source of sources) source.close()
            for (const cleanup of cleanups) cleanup()
        }
    }, [id, key, attempt])

    // A statement rather than an alarm. A site with nothing running has nothing to follow, which is not
    // itself a problem, and when it is one the page already carries the reason above this.
    if (!services.length) {
        return <p className={styles.empty}>{waiting ?? 'Nothing is running, so there is nothing to follow.'}</p>
    }

    function toggle(service: string) {
        setChosen(previous => previous.includes(service)
            ? previous.filter(name => name !== service)
            // Kept in the order the site lists its containers rather than the order they were clicked,
            // so the same selection is always the same set of streams and the same key.
            : services.filter(name => name === service || previous.includes(name)))
    }

    // What is being asked of the site outranks what its streams are doing: half of them being down is
    // the restart happening, and counting them as a shortfall says the opposite.
    const said = waiting ? { text: waiting, bad: false } : summarise(chosen.map(service => states[service] ?? 'connecting'))
    // Held back rather than cleared, so a stream that was genuinely refused before any of this says so
    // again the moment the operation is over.
    const refused = waiting ? [] : Object.entries(problems)

    return (
        <>
            <div className={styles.logHead}>
                <span className={styles.filterLabel} id={`containers-${id}`}>containers</span>
                <div className={styles.filter} role="group" aria-labelledby={`containers-${id}`}>
                    {services.map(name => (
                        <Button
                            key={name}
                            size="small"
                            variant={chosen.includes(name) ? 'primary' : undefined}
                            aria-pressed={chosen.includes(name)}
                            onClick={() => toggle(name)}
                        >
                            {name}
                        </Button>
                    ))}
                </div>
                <span className={said.bad ? styles.stateBad : styles.state}>{said.text}</span>
            </div>

            {refused.length > 0 && (
                <div className={styles.said}>
                    <Callout tone="crit" title={refused.length === 1 ? 'The log stream did not open' : 'Some log streams did not open'}>
                        {refused.map(([service, message]) => (
                            <p className={styles.note} key={service}>{service}: {message}</p>
                        ))}
                        <div className={styles.save}>
                            <Button size="small" onClick={() => setAttempt(count => count + 1)}>Try again</Button>
                        </div>
                    </Callout>
                </div>
            )}

            <LogPane
                lines={lines}
                label={chosen.length === 1 ? `${chosen[0]} logs` : 'Container logs'}
                fill
            />
        </>
    )
}
