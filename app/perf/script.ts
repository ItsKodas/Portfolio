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
// Lite is also forced when the browser is drawing without the graphics card (hardware acceleration turned off, or a
// blocked driver): WebGL then either refuses a context flagged failIfMajorPerformanceCaveat, or reports a software
// renderer. Such a machine reports a fine pointer, so without this check it would be handed the whole scene and,
// because it starts at its ceiling, would never be frame checked either.
//
// For testing, ?perf=lite or ?perf=full forces a mode and remembers it in this browser; ?perf=auto goes back to
// detecting; ?scene=depth+sky forces an exact set of tokens for this load only.

const ALL_TOKENS = TIERS.map(t => t.token).join(' ')

export const PERF_SCRIPT = `(function () {
    var root = document.documentElement, forced = null
    var all = ${JSON.stringify(ALL_TOKENS)}, count = ${TIERS.length}

    function apply(scene, max, isForced) {
        root.setAttribute('data-scene', scene)
        root.setAttribute('data-scene-max', String(max))
        // (bridge for the stylesheets until they've moved over to data-scene)
        root.setAttribute('data-perf', scene === all ? 'full' : 'lite')
        if (isForced) root.setAttribute('data-perf-forced', '')
    }

    try {
        var params = new URLSearchParams(location.search)
        var scene = params.get('scene')
        if (scene !== null) {
            apply(scene.trim(), count, true)
            return
        }
        var asked = params.get('perf')
        if (asked === 'lite' || asked === 'full') localStorage.setItem('perf', asked)
        else if (asked === 'auto') localStorage.removeItem('perf')
        forced = localStorage.getItem('perf')
    } catch (e) {}

    if (forced === 'lite' || forced === 'full') {
        apply(forced === 'full' ? all : '', forced === 'full' ? count : 0, true)
        return
    }

    var ceiling = 0
    try {
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
                window.matchMedia('(pointer: coarse)').matches,
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

    apply(ceiling === count ? all : '', ceiling, false)
})()`
