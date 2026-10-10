import { describe, expect, it } from 'vitest'

import { TOKEN_REMOVED, withoutTokens } from './emails'

describe('withoutTokens', () => {
    it('takes the token out of an invite link and a reset link, in text and in an href alike', () => {
        const text = 'Set it here: https://horizons.gg/portal/invite/Ab_c-123XYZ\n'
        const html = '<a href="https://horizons.gg/portal/reset/Zz9_-q">Set a new password</a>'
        expect(withoutTokens(text)).toBe(`Set it here: https://horizons.gg/portal/invite/${TOKEN_REMOVED}\n`)
        expect(withoutTokens(html)).toBe(`<a href="https://horizons.gg/portal/reset/${TOKEN_REMOVED}">Set a new password</a>`)
    })

    it('leaves every other link alone', () => {
        const text = 'See https://horizons.gg/portal/sites/asot and https://horizons.gg/admin/quotes/abc'
        expect(withoutTokens(text)).toBe(text)
    })
})
