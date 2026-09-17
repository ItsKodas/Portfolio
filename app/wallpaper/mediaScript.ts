// Registers for what's playing on the computer (see media.ts). Wallpaper Engine asks for its listeners to be registered
// straight away, not once the page has loaded, so this runs as an inline script at the top of the page (see layout.tsx),
// plain, old-fashioned JavaScript: it keeps the latest of each kind of event (noting when it came, for track details when
// that track started, and for playback what it was before), and passes new ones on to whatever has subscribed since.
export const MEDIA_SCRIPT = `(function () {
    var media = window.__wallpaperMedia = { events: {}, listeners: [] }
    function keep(kind) {
        return function (event) {
            var last = media.events[kind]
            event.receivedAt = Date.now()
            if (kind === 'playback') event.previousState = last ? last.state : undefined
            if (kind === 'properties') {
                var same = last && last.title === event.title && last.artist === event.artist
                event.trackAt = same ? last.trackAt : event.receivedAt
            }
            media.events[kind] = event
            media.listeners.forEach(function (listener) { listener() })
        }
    }
    var register = {
        status: window.wallpaperRegisterMediaStatusListener,
        properties: window.wallpaperRegisterMediaPropertiesListener,
        thumbnail: window.wallpaperRegisterMediaThumbnailListener,
        playback: window.wallpaperRegisterMediaPlaybackListener,
        timeline: window.wallpaperRegisterMediaTimelineListener
    }
    for (var kind in register) if (typeof register[kind] === 'function') register[kind](keep(kind))
})()`
