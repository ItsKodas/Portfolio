// Where the page content sits against the hero, shared by the parallax that moves it and anything that scrolls to it

export const CONTENT_OFFSET = 0.96 // screens from the top where the content starts
export const CONTENT_SPEED  = 1    // the content rises (1 + this) pixels for every pixel scrolled

// Scrolls the page (smoothly unless told otherwise) until el sits `margin` pixels below the top of the screen.
// scrollIntoView can't do this: the content rises faster than the scroll, so it would undershoot. (It also used to
// scroll the page's wrapper as well as the window, which left the page stuck; the wrapper is overflow-clip now, which
// nothing can scroll.) Measured with the content at rest, which is where it is whenever someone clicks.
export function scrollToContent(el: HTMLElement, margin = 48, behavior: ScrollBehavior = 'smooth') {
    const top = window.scrollY + (el.getBoundingClientRect().top - margin) / (1 + CONTENT_SPEED)
    window.scrollTo({ top: Math.max(0, top), behavior })
}
