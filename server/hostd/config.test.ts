import { describe, expect, it } from 'vitest'

import { readHostd } from './config'

describe('readHostd', () => {
    it('reads the url and the token', () => {
        const problems: string[] = []
        const config = readHostd({ HOSTD_URL: 'http://hostd-api:8080', HOSTD_API_TOKEN: 'a'.repeat(32) }, problems)
        expect(problems).toEqual([])
        expect(config).toEqual({ url: 'http://hostd-api:8080', token: 'a'.repeat(32) })
    })

    it('collects both missing settings by name, and never prints the token', () => {
        const problems: string[] = []
        readHostd({}, problems)
        expect(problems).toEqual(['HOSTD_URL is not set', 'HOSTD_API_TOKEN is not set'])
    })

    it('refuses a token short enough to be a placeholder', () => {
        const problems: string[] = []
        readHostd({ HOSTD_URL: 'http://hostd-api:8080', HOSTD_API_TOKEN: 'short' }, problems)
        expect(problems).toEqual(['HOSTD_API_TOKEN must be at least 32 characters'])
        expect(problems.join(' ')).not.toContain('short')
    })

    it('refuses a url that is not http', () => {
        const problems: string[] = []
        readHostd({ HOSTD_URL: 'hostd-api:8080', HOSTD_API_TOKEN: 'a'.repeat(32) }, problems)
        expect(problems).toEqual(['HOSTD_URL must be an http or https URL'])
    })
})
