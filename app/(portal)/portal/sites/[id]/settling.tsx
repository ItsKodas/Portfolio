'use client'

// What the page knows while a site is between states, shared by everything on it that reports a reading.
//
// Starting, stopping and restarting all answer the moment hostd has taken the job, not when it is done,
// so for the seconds after one the page is reading a site mid-operation and reporting it as news: the
// strip said "down", the dot went red, and the log relay refused a stream for a container that was not
// there yet and showed that refusal as a problem to be retried by hand. None of it was wrong, and all of
// it was noise about something the operator had asked for ten seconds earlier.
//
// So one piece of state, held above all of them: what was asked for, and where it ends. Consumers read
// it to say what is happening rather than what they can currently see.

import { useRouter } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { SiteState } from '../../siteState'

export type LifecycleAction = 'start' | 'stop' | 'restart'

export type Settling = {
    action: LifecycleAction
    // The state the page is waiting to read. Reaching it is the only thing that ends this normally.
    target: SiteState
    // When it was asked for, which the floor below is measured from
    since: number
}

type Value = {
    settling: Settling | null
    // The last thing asked for ran out of patience rather than finishing. Cleared by the next thing asked.
    gaveUp: boolean
    begin: (action: LifecycleAction) => void
}

// Nothing here is pushed to the browser, so the page is asked again. Often enough to feel like a wait
// that is being watched, not so often that a restart is thirty status calls.
const POLL_MS = 2500

// How long before a reading is allowed to end the wait. Without it a restart ends on its first poll:
// hostd still reports the containers as running in the moment between the call returning and Docker
// tearing them down, and that reading is of the site as it was, not as it will be.
const FLOOR_MS = 8000

// A lifecycle call is seconds of work. A minute and a half of it not having happened means it is not
// going to, and a page that spins for ever is worse than one that admits it does not know.
const GIVE_UP_MS = 90000

// Where each of them ends. A start and a restart both finish with the site up; a stop finishes stopped,
// which is why this is a map and not a constant.
const TARGET: Record<LifecycleAction, SiteState> = { start: 'up', stop: 'stopped', restart: 'up' }

// The word for what is happening, where a state would otherwise be printed. Lower case, because it
// stands in the same place as up, down and stopped.
export const DOING: Record<LifecycleAction, string> = {
    start: 'starting',
    stop: 'stopping',
    restart: 'restarting',
}

// The default is a working one rather than a throw: the Logs tab renders the log on its own, with no
// controls above it and so nothing that could ever begin a wait. Outside a provider, nothing is settling
// and nothing ever will be, which is the truth on that tab.
const NOTHING: Value = { settling: null, gaveUp: false, begin: () => {} }

const Context = createContext<Value>(NOTHING)

export function useSettling(): Value {
    return useContext(Context)
}

// state is what the server component last read the site as. It arrives again on every refresh below,
// which is how this finds out the operation is over.
export function SettlingProvider({ state, children }: { state: SiteState, children: ReactNode }) {
    const router = useRouter()
    const [settling, setSettling] = useState<Settling | null>(null)
    const [gaveUp, setGaveUp] = useState(false)
    // Bumped by the poll purely to re-run the check below. The floor can pass with nothing else having
    // changed, and without this the wait would then sit there until the state happened to move again.
    const [tick, setTick] = useState(0)

    // The clock. Hung on the settle itself and on nothing that changes underneath it, so a state arriving
    // mid-wait does not quietly restart the patience and leave this going round for ever.
    useEffect(() => {
        if (!settling) return
        const poll = setInterval(() => {
            setTick(count => count + 1)
            router.refresh()
        }, POLL_MS)
        const patience = setTimeout(() => {
            setSettling(null)
            setGaveUp(true)
        }, GIVE_UP_MS)
        return () => {
            clearInterval(poll)
            clearTimeout(patience)
        }
    }, [settling, router])

    // The end of it. Deliberately only the target: a state nobody could read is the middle of the
    // operation rather than the end of it, and so is every state that is not the one being waited for.
    useEffect(() => {
        if (!settling) return
        if (Date.now() - settling.since < FLOOR_MS) return
        if (state === settling.target) setSettling(null)
    }, [settling, state, tick])

    const begin = useCallback((action: LifecycleAction) => {
        setGaveUp(false)
        setTick(0)
        setSettling({ action, target: TARGET[action], since: Date.now() })
    }, [])

    const value = useMemo(() => ({ settling, gaveUp, begin }), [settling, gaveUp, begin])

    return <Context.Provider value={value}>{children}</Context.Provider>
}
