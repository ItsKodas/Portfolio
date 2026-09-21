// Brings in jest-dom's matchers (toBeInTheDocument, toHaveAccessibleName and the rest) and clears the
// rendered tree between tests, so one test's dialog cannot be found by the next.

import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

// jsdom implements no part of the dialog modal API, in any version: showModal, show and close are all
// undefined. These stand-ins let a test exercise our own wiring. They deliberately do not reproduce focus
// trapping, the top layer or page inertness, which belong to the browser and are checked by eye in the
// gallery at /admin/ui.
// jsdom implements no EventSource either, and a page that streams its logs opens one the moment it
// renders, so without this every test that renders such a page dies inside an effect. This one is
// deliberately inert: it connects to nothing and delivers nothing, which is what a test that is not
// about the stream wants. A test that is about the stream puts its own in place of it.
if (typeof globalThis.EventSource === 'undefined') {
    class InertEventSource {
        onopen: (() => void) | null = null
        onerror: (() => void) | null = null
        onmessage: (() => void) | null = null
        readonly readyState = 0
        constructor(readonly url: string) {}
        addEventListener(): void {}
        removeEventListener(): void {}
        dispatchEvent(): boolean { return false }
        close(): void {}
    }
    globalThis.EventSource = InertEventSource as unknown as typeof EventSource
}

if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
    HTMLDialogElement.prototype.show = function () { this.open = true }
    HTMLDialogElement.prototype.close = function (returnValue?: string) {
        this.open = false
        if (returnValue !== undefined) this.returnValue = returnValue
        this.dispatchEvent(new Event('close'))
    }
}
