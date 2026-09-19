// Remembers when a device couldn't hold the scene it was given. Phones are handed the whole scene on a budget no phone
// reports enough to check, and one that can't hold it dies on screen and is reloaded by the browser, which on the
// original bug meant crashing again on every load until the browser gave up.
//
// So the tiers on screen are marked live in storage while the page is shown, and the mark is cleared whenever the page
// is hidden or left. The one way it survives is the page dying while on screen, and the head script, finding it on the
// next load, holds this device to a lower tier from then on (see script.ts). Clearing on hide is what keeps a phone
// discarding a backgrounded tab from being mistaken for a crash.

const LIVE = 'scene-live'

const forced = () => document.documentElement.hasAttribute('data-perf-forced')
const tiersOnScreen = () => (document.documentElement.getAttribute('data-scene') || '').split(/\s+/).filter(Boolean).length

// Marks what is on screen now, when the page is showing and chose its own tiers
export function recordLive() {
    try {
        if (forced() || document.hidden) return
        localStorage.setItem(LIVE, String(tiersOnScreen()))
    } catch (e) {}
}

function clear() {
    try { localStorage.removeItem(LIVE) } catch (e) {}
}

// Keeps the mark in step with whether the page is showing, from now until the returned stop is called
export function startCrashGuard() {
    if (forced()) return () => {}
    const onVisibility = () => (document.hidden ? clear() : recordLive())

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', clear)
    window.addEventListener('pageshow', recordLive)
    recordLive()

    return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pagehide', clear)
        window.removeEventListener('pageshow', recordLive)
    }
}
