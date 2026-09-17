// Decides, before the page first paints, whether this browser gets the full hero or the lite one, and marks it on the
// root as data-perf="full" or "lite" (the stylesheets switch their animations off from that, and the parallax reads it
// when it mounts). Runs as an inline script in the head, so it's plain, old-fashioned JavaScript.
//
// Lite is chosen when the browser is drawing without the graphics card (hardware acceleration turned off, or a blocked
// driver): WebGL then either refuses a context flagged failIfMajorPerformanceCaveat, or reports a software renderer.
// Browsers that pass this but still can't keep up are caught later by timing frames (see usePerf.ts).
//
// For testing, ?perf=lite or ?perf=full forces a mode and remembers it in this browser; ?perf=auto goes back to detecting.

export const PERF_SCRIPT = `(function () {
    var root = document.documentElement, forced = null
    try {
        var asked = new URLSearchParams(location.search).get('perf')
        if (asked === 'lite' || asked === 'full') localStorage.setItem('perf', asked)
        else if (asked === 'auto') localStorage.removeItem('perf')
        forced = localStorage.getItem('perf')
    } catch (e) {}
    if (forced === 'lite' || forced === 'full') {
        root.setAttribute('data-perf', forced)
        root.setAttribute('data-perf-forced', '')
        return
    }

    var lite = false
    try {
        var canvas = document.createElement('canvas')
        var gl = canvas.getContext('webgl', { failIfMajorPerformanceCaveat: true })
        if (!gl) lite = true
        else {
            var info = gl.getExtension('WEBGL_debug_renderer_info')
            var renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
            if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) lite = true
            var lose = gl.getExtension('WEBGL_lose_context')
            if (lose) lose.loseContext()
        }
    } catch (e) {}
    root.setAttribute('data-perf', lite ? 'lite' : 'full')
})()`
