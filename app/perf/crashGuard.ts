// Remembers when a device couldn't hold the scene it was given. Phones are handed more of the scene than any phone
// reports enough to check, and one that can't hold it dies on screen and is reloaded by the browser, which on the
// original bug meant crashing again on every load until the browser gave up.
//
// So the tiers on screen are marked live for this tab while the page is shown, and the mark is cleared whenever the
// page is hidden or left. The one way it survives is the page dying while on screen, and the head script, finding it
// on the next load in this tab, holds this device to a lower tier from then on (see script.ts). Clearing on hide is what
// keeps a phone discarding a backgrounded tab from being mistaken for a crash; keeping the mark per tab, and only ever
// marking a page actually on screen, is what keeps a preloaded page or another tab from being mistaken for one.

const LIVE = 'scene-live'

const forced = () => document.documentElement.hasAttribute('data-perf-forced')
const onScreen = () => !document.hidden && !(document as { prerendering?: boolean }).prerendering
const tiersOnScreen = () => (document.documentElement.getAttribute('data-scene') || '').split(/\s+/).filter(Boolean).length

// The test mode's log (see ?debug=perf in script.ts): appends a line once the log has been turned on, otherwise nothing
export function note(text: string) {
    try {
        if (localStorage.getItem('scene-debug') !== '1') return
        const log = JSON.parse(localStorage.getItem('scene-log') ?? '[]') as string[]
        log.push(`${new Date().toTimeString().slice(0, 8)} ${text}`)
        localStorage.setItem('scene-log', JSON.stringify(log.slice(-30)))
    } catch (e) {}
}

// Marks what is on screen now, when the page is showing and chose its own tiers
export function recordLive() {
    try {
        if (forced() || !onScreen()) return
        const tiers = String(tiersOnScreen())
        if (sessionStorage.getItem(LIVE) === tiers) return
        sessionStorage.setItem(LIVE, tiers)
        note(`mark ${tiers}`)
    } catch (e) {}
}

function clear(why: string) {
    try {
        if (sessionStorage.getItem(LIVE) === null) return
        sessionStorage.removeItem(LIVE)
        note(`clear ${why}`)
    } catch (e) {}
}

// Keeps the mark in step with whether the page is showing, from now until the returned stop is called
export function startCrashGuard() {
    if (forced()) return () => {}
    const onVisibility = () => (document.hidden ? clear('hidden') : recordLive())
    const onPageHide = () => clear('pagehide')

    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('prerenderingchange', recordLive)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', recordLive)
    recordLive()

    return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        document.removeEventListener('prerenderingchange', recordLive)
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('pageshow', recordLive)
    }
}
