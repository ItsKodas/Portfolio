import { describe, expect, it } from 'vitest'

import { readPaypal } from './config'

const env = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', AUTH_URL: 'https://www.horizons.gg/', NODE_ENV: 'production' }

describe('readPaypal', () => {
    it('talks to the sandbox unless told otherwise', () => {
        const setup = readPaypal(env)
        expect(setup.ok && setup.value).toMatchObject({ mode: 'sandbox', apiBase: 'https://api-m.sandbox.paypal.com', siteUrl: 'https://www.horizons.gg', webhookId: null })
    })

    it('talks to live PayPal in production when told to', () => {
        const setup = readPaypal({ ...env, PAYPAL_MODE: 'live', PAYPAL_WEBHOOK_ID: 'wh' })
        expect(setup.ok && setup.value).toMatchObject({ mode: 'live', apiBase: 'https://api-m.paypal.com', webhookId: 'wh' })
    })

    it('refuses live money outside a production build', () => {
        const setup = readPaypal({ ...env, PAYPAL_MODE: 'live', NODE_ENV: 'development' })
        expect(setup.ok).toBe(false)
        expect(!setup.ok && setup.problems.join()).toMatch(/production build/)
    })

    it('names what is missing, never what is set', () => {
        const setup = readPaypal({ PAYPAL_MODE: 'test', PAYPAL_CLIENT_SECRET: 'hunter2' })
        expect(setup.ok).toBe(false)
        const problems = !setup.ok ? setup.problems.join('; ') : ''
        expect(problems).toMatch(/PAYPAL_MODE must be sandbox or live/)
        expect(problems).toMatch(/PAYPAL_CLIENT_ID is not set/)
        expect(problems).not.toMatch(/hunter2/)
    })
})
