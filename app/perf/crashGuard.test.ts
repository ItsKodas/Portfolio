import { afterEach, describe, expect, it } from 'vitest'

import { CAP_WEEK_MS, describeCap, recordLive, startCrashGuard } from './crashGuard'

// A stand-in document, window and storage, enough to hide, show and leave a page and see what it remembers

function harness({ scene = 'depth sky', forced = false, storageThrows = false, prerendering = false, logging = false } = {}) {
    const attrs: Record<string, string> = { 'data-scene': scene }
    if (forced) attrs['data-perf-forced'] = ''
    const listeners: Record<string, Set<() => void>> = {}
    const on = (type: string, cb: () => void) => { (listeners[type] ??= new Set()).add(cb) }
    const off = (type: string, cb: () => void) => { listeners[type]?.delete(cb) }
    const fire = (type: string) => Array.from(listeners[type] ?? []).forEach(l => l())

    const fakeDocument = {
        hidden: false,
        prerendering,
        documentElement: {
            getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
            hasAttribute: (k: string) => k in attrs,
        },
        addEventListener: on,
        removeEventListener: off,
    }
    const store: Record<string, string> = {}   // this tab's sessionStorage
    const shared: Record<string, string> = logging ? { 'scene-debug': '1' } : {}   // localStorage
    const boom = () => { throw new Error('storage disabled') }
    const fake = (backing: Record<string, string>) => (storageThrows ? { getItem: boom, setItem: boom, removeItem: boom } : {
        getItem: (k: string) => (k in backing ? backing[k] : null),
        setItem: (k: string, v: string) => { backing[k] = v },
        removeItem: (k: string) => { delete backing[k] },
    }) as unknown as Storage

    globalThis.document = fakeDocument as unknown as Document
    globalThis.window = { addEventListener: on, removeEventListener: off } as unknown as Window & typeof globalThis
    globalThis.sessionStorage = fake(store)
    globalThis.localStorage = fake(shared)

    return {
        live: () => store['scene-live'],
        sharedLive: () => shared['scene-live'],
        log: () => JSON.parse(shared['scene-log'] ?? '[]') as string[],
        activate: () => { fakeDocument.prerendering = false; fire('prerenderingchange') },
        setScene: (s: string) => { attrs['data-scene'] = s },
        hide: () => { fakeDocument.hidden = true; fire('visibilitychange') },
        show: () => { fakeDocument.hidden = false; fire('visibilitychange') },
        fire,
        listenerCount: () => Object.values(listeners).reduce((n, s) => n + s.size, 0),
    }
}

afterEach(() => {
    delete (globalThis as { document?: unknown }).document
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { localStorage?: unknown }).localStorage
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage
})

describe('the crash guard', () => {
    it('marks the tiers on screen as live when it starts', () => {
        const h = harness()
        startCrashGuard()
        expect(h.live()).toBe('2')
    })

    it('clears the mark while the page is hidden, and restores it when shown', () => {
        // so a phone discarding a backgrounded tab is never mistaken for a crash
        const h = harness()
        startCrashGuard()
        h.hide()
        expect(h.live()).toBeUndefined()
        h.show()
        expect(h.live()).toBe('2')
    })

    it('clears the mark when the page is left', () => {
        const h = harness()
        startCrashGuard()
        h.fire('pagehide')
        expect(h.live()).toBeUndefined()
    })

    it('restores the mark when the page comes back from the back-forward cache', () => {
        const h = harness()
        startCrashGuard()
        h.fire('pagehide')
        h.fire('pageshow')
        expect(h.live()).toBe('2')
    })

    it('records a change of tier', () => {
        const h = harness()
        startCrashGuard()
        h.setScene('depth')
        recordLive()
        expect(h.live()).toBe('1')
    })

    it('does not mark a hidden page', () => {
        const h = harness()
        h.hide()
        recordLive()
        expect(h.live()).toBeUndefined()
    })

    it('leaves a forced page alone entirely', () => {
        // a mode forced for testing isn't this device's own choice, so it neither marks nor listens
        const h = harness({ forced: true })
        startCrashGuard()
        recordLive()
        expect(h.live()).toBeUndefined()
        expect(h.listenerCount()).toBe(0)
    })

    it('survives storage that throws', () => {
        harness({ storageThrows: true })
        expect(() => { startCrashGuard(); recordLive() }).not.toThrow()
    })

    it('stops listening once stopped', () => {
        const h = harness()
        const stop = startCrashGuard()
        stop()
        expect(h.listenerCount()).toBe(0)
    })

    it('keeps the mark to this tab, out of the storage every page of the site shares', () => {
        const h = harness()
        startCrashGuard()
        expect(h.live()).toBe('2')
        expect(h.sharedLive()).toBeUndefined()
    })

    it('does not mark a page being prerendered, until it is shown', () => {
        const h = harness({ prerendering: true })
        startCrashGuard()
        expect(h.live()).toBeUndefined()
        h.activate()
        expect(h.live()).toBe('2')
    })

    it('logs what it does once the test mode has turned the log on', () => {
        const h = harness({ logging: true })
        startCrashGuard()
        h.hide()
        expect(h.log().some(e => /mark 2/.test(e))).toBe(true)
        expect(h.log().some(e => /clear hidden/.test(e))).toBe(true)
    })

    it('logs nothing otherwise', () => {
        const h = harness()
        startCrashGuard()
        h.hide()
        expect(h.log()).toEqual([])
    })
})

const DAY = 864e5

// The cap the head script stores carries the moment it was written and the weeks it is good for, which is three numbers
// and far more than the ?debug=perf readout has room for on a phone. So it is read back as the tier and the days the cap
// still has to run, and a cap past its window says so rather than looking like one still in force.
describe('a stored cap, as the readout shows it', () => {
    it('reads a live cap back as its tier and the days it has left', () => {
        expect(describeCap(`1 ${Date.now() - 5 * DAY} 1`)).toBe('1 for 2d')
    })

    it('counts the longer window a re-earned cap was given', () => {
        expect(describeCap(`0 ${Date.now() - 5 * DAY} 2`)).toBe('0 for 9d')
    })

    it('says so when the device has no cap at all', () => {
        expect(describeCap(null)).toBe('none')
    })

    it('calls a cap past its window spent, because the next load drops it', () => {
        expect(describeCap(`0 ${Date.now() - 8 * DAY} 1`)).toBe('0 (spent)')
    })

    it('calls a bare cap from an earlier version spent too, for the same reason', () => {
        expect(describeCap('0')).toBe('0 (spent)')
    })
})
