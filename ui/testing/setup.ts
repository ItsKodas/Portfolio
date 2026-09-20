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
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
    HTMLDialogElement.prototype.show = function () { this.open = true }
    HTMLDialogElement.prototype.close = function (returnValue?: string) {
        this.open = false
        if (returnValue !== undefined) this.returnValue = returnValue
        this.dispatchEvent(new Event('close'))
    }
}
