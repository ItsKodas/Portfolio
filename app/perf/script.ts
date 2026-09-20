import { BASE, BUDGETS, TIERS, TILE_MIN, ceilingFor } from './tiers'

// Decides, before the page first paints, how much of the hero scene this browser is given, and marks it on the root
// as data-scene="<tokens>" (cumulative, in TIERS order) plus data-scene-max, the most it could afford. The
// stylesheets switch their animations on from the tokens, and the parallax reads them when it mounts. Runs as an
// inline script in the head, so it's plain, old-fashioned JavaScript.
//
// A device that can afford the whole scene is handed it outright and never climbs. Anything short of that starts on
// the still scene and climbs after the loading curtain lifts (see climb.ts), which is the point: the phone never has
// to composite more than it can hold, and the old fallback could not switch for another 7 to 12 seconds, by which
// time the tab was already dead.
//
// Tier 0, the still scene, is also forced when the browser is drawing without the graphics card (hardware
// acceleration turned off, or a blocked driver): WebGL then either refuses a context flagged
// failIfMajorPerformanceCaveat, or reports a software renderer. Such a machine reports a fine pointer, so without
// this check it would be handed the whole scene and, because it starts at its ceiling, would never be frame checked
// either.
//
// For testing, ?perf=lite or ?perf=full forces a mode and remembers it in this browser; ?perf=auto goes back to
// detecting; ?scene=depth+sky forces an exact set of tokens for this load only.

const ALL_TOKENS = TIERS.map(t => t.token).join(' ')

export const PERF_SCRIPT = `(function () {
    var root = document.documentElement, forced = null
    var all = ${JSON.stringify(ALL_TOKENS)}, count = ${TIERS.length}

    // The test mode's guard log (see crashGuard.ts), on from ?debug=perf until ?debug=off, so a misfire on a phone
    // that can't be attached to a profiler can be read off the page. Normal visitors never turn it on.
    var logging = false
    try {
        var debug = new URLSearchParams(location.search).get('debug')
        if (debug === 'perf') localStorage.setItem('scene-debug', '1')
        else if (debug === 'off') { localStorage.removeItem('scene-debug'); localStorage.removeItem('scene-log') }
        logging = localStorage.getItem('scene-debug') === '1'
    } catch (e) {}
    function note(text) {
        if (!logging) return
        try {
            var log = JSON.parse(localStorage.getItem('scene-log') || '[]')
            log.push(new Date().toTimeString().slice(0, 8) + ' ' + text)
            localStorage.setItem('scene-log', JSON.stringify(log.slice(-30)))
        } catch (e) {}
    }

    function apply(scene, max, isForced) {
        root.setAttribute('data-scene', scene)
        root.setAttribute('data-scene-max', String(max))
        if (isForced) { root.setAttribute('data-perf-forced', ''); note('load ' + (location.search || '/') + ' forced') }
    }

    try {
        var params = new URLSearchParams(location.search)
        var scene = params.get('scene')
        if (scene !== null) {
            // The ceiling is what was actually forced, not the whole scale: ?scene=depth with a max of 4 describes a
            // document with three unclaimed tiers above it, which is nonsense however inert data-perf-forced makes it.
            var tokens = scene.trim()
            apply(tokens, tokens ? tokens.split(/\\s+/).length : 0, true)
            return
        }
        var asked = params.get('perf')
        if (asked === 'lite' || asked === 'full' || asked === 'auto') {
            // (auto also forgets an old crash cap, below: it's the way back to what detection alone would give. But not
            // a crash that has only just happened: the browser reloads a crashed page at the same address, so throwing
            // the fresh mark away here would hand the scene out again on every reload, a crash loop forced by a URL.)
            if (asked === 'auto') try { localStorage.removeItem('scene-cap') } catch (e3) {}
            // The override takes effect on this load whether or not it could be remembered for the next one. A
            // browser blocking storage throws below, and the right answer to that is to lose the memory, not the
            // override, so the persisting gets a try of its own.
            forced = asked === 'auto' ? null : asked
            try {
                if (asked === 'auto') localStorage.removeItem('perf')
                else localStorage.setItem('perf', asked)
            } catch (e2) {}
        } else {
            forced = localStorage.getItem('perf')
        }
    } catch (e) {}

    if (forced === 'lite' || forced === 'full') {
        apply(forced === 'full' ? all : '', forced === 'full' ? count : 0, true)
        return
    }

    var ceiling = 0, coarse = false
    try {
        coarse = window.matchMedia('(pointer: coarse)').matches

        // Drawing without the graphics card? Then nothing beyond the still scene is affordable, whatever the
        // memory says.
        var software = false
        var canvas = document.createElement('canvas')
        var gl = canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true })
        if (!gl) software = true
        else {
            var info = gl.getExtension('WEBGL_debug_renderer_info')
            var renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
            if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) software = true
            var lose = gl.getExtension('WEBGL_lose_context')
            if (lose) lose.loseContext()
        }

        if (!software) {
            var ceilingFor = ${ceilingFor.toString()}
            ceiling = ceilingFor(
                window.innerWidth,
                window.innerHeight,
                window.devicePixelRatio || 1,
                navigator.deviceMemory,
                coarse,
                ${JSON.stringify(TIERS)},
                ${JSON.stringify(BASE)},
                ${TILE_MIN},
                ${JSON.stringify(BUDGETS)}
            )
        }
    } catch (e) {
        // The still scene is the safe answer, and the only one that definitely doesn't get the tab killed
        ceiling = 0
    }

    // A phone that can't hold what it's handed dies on screen and the browser reloads it, in the same tab. The page
    // marks the tiers it is showing as live for that tab and clears the mark whenever it is hidden or left normally
    // (see crashGuard.ts), so finding the mark here means the last page in this tab died on screen. Then this device is
    // held to the depth tier from now on (or the still scene, if it died there): straight to depth rather than one
    // tier down, because the stars are the big memory cost, and stepping down one tier at a time would keep them
    // through two more crashes.
    //
    // The mark is per tab (sessionStorage), and only a page actually on screen reads or writes it. It used to live in
    // storage every page of the site shares, and be read and written whether or not the page was showing, so a page
    // the browser preloaded, or one opened alongside, took another page's mark for a crash: a phone was held to the
    // still scene on every plain load with no crash at all. A page out of sight still obeys a cap already remembered.
    //
    // Only a touch device is judged this way, because only a touch device is what the guard is for. The cost of the
    // trade is that a mark is not actually proof of a crash: sessionStorage is copied into a duplicated tab, and
    // brought back by a session restore after the browser or the machine restarts, so a mark can be read with the page
    // that wrote it still alive, or hours after the fact. On a phone that is worth it, because the alternative is the
    // crash loop. A device with a fine pointer was never the one at risk, gets a budget it is nowhere near, and is not
    // reloaded into the same crash when its tab is killed, so there the trade is all cost: a capable PC was left a
    // tier down for good on no crash at all, with no reload able to talk it back out of it. The cap stays in storage
    // rather than being cleared, for a convertible whose next visit is in tablet mode.
    var shown = document.visibilityState === 'visible' && !document.prerendering
    var live = null, before = null, cap = null
    try {
        localStorage.removeItem('scene-live')   // (where older versions kept the mark)
        cap = before = localStorage.getItem('scene-cap')
        if (coarse) {
            if (shown) live = sessionStorage.getItem('scene-live')
            if (live !== null) {
                var held = Number(live) > 1 ? 1 : 0
                cap = String(cap === null ? held : Math.min(Number(cap), held))
                localStorage.setItem('scene-cap', cap)
            }
            if (cap !== null) ceiling = Math.min(ceiling, Number(cap))
        }
    } catch (e) {}

    var handed = ceiling === count ? count : 0
    apply(handed === count ? all : '', ceiling, false)
    if (shown) try { sessionStorage.setItem('scene-live', String(handed)) } catch (e) {}
    note('load ' + (location.search || '/') + ' ' + (shown ? 'shown' : document.prerendering ? 'prerender' : 'hidden')
        + ' mark ' + (live === null ? '-' : live) + ' cap ' + (before === null ? '-' : before) + ' > ' + (cap === null ? '-' : cap)
        + ' max ' + ceiling)
})()`
