import { describe, expect, it } from 'vitest'

import { firstErrors, quoteSchema } from './schema'

const valid = { name: 'Ann Lee', email: 'ann@example.com', message: 'I would like a new website for my bakery.' }

const errorsFor = (input: unknown) => {
    const result = quoteSchema.safeParse(input)
    if (result.success) throw new Error('expected the input to be rejected')
    return firstErrors(result.error)
}

describe('quoteSchema', () => {
    it('accepts the required fields alone, with every optional field null', () => {
        expect(quoteSchema.parse(valid)).toEqual({
            ...valid,
            company: null, website: null, projectType: null, budget: null, timeline: null, referenceSites: [],
        })
    })

    it('treats blank optional fields as not given, which is what the form sends for untouched fields', () => {
        const parsed = quoteSchema.parse({ ...valid, company: '  ', website: '', projectType: '', budget: '', timeline: '', referenceSites: ['', ' '] })
        expect(parsed).toMatchObject({ company: null, website: null, projectType: null, budget: null, timeline: null, referenceSites: [] })
    })

    it('trims text', () => {
        expect(quoteSchema.parse({ ...valid, name: '  Ann  ', company: ' Bakery ' })).toMatchObject({ name: 'Ann', company: 'Bakery' })
    })

    it('keeps every option it offers', () => {
        const parsed = quoteSchema.parse({ ...valid, projectType: 'WEB_APP', budget: 'FROM_2K_TO_5K', timeline: 'FLEXIBLE' })
        expect(parsed).toMatchObject({ projectType: 'WEB_APP', budget: 'FROM_2K_TO_5K', timeline: 'FLEXIBLE' })
    })

    it('requires a name, an email and a message of at least 10 characters', () => {
        expect(errorsFor({ name: ' ', email: '', message: 'too short' })).toEqual({
            name: 'Please enter your name',
            email: 'Please enter a valid email address',
            message: 'Tell me a little more (at least 10 characters)',
        })
    })

    it('rejects line breaks in single-line fields, which keeps them out of email headers', () => {
        expect(errorsFor({ ...valid, name: 'Ann\nBcc: x@example.com', company: 'A\r\nB' })).toEqual({
            name: 'Keep this on one line',
            company: 'Keep this on one line',
        })
    })

    it('enforces the maximum lengths', () => {
        expect(errorsFor({ ...valid, name: 'a'.repeat(101), company: 'a'.repeat(101), message: 'a'.repeat(5001) })).toEqual({
            name: 'Keep this under 100 characters',
            company: 'Keep this under 100 characters',
            message: 'Keep this under 5,000 characters',
        })
        expect(errorsFor({ ...valid, email: `${'a'.repeat(250)}@example.com` })).toEqual({ email: 'Keep this under 254 characters' })
    })

    it('only accepts http and https web addresses', () => {
        for (const website of ['javascript:alert(1)', 'ftp://example.com', 'example.com', 'not a url']) {
            expect(errorsFor({ ...valid, website })).toEqual({ website: 'Enter a full web address, starting with https://' })
        }
        expect(quoteSchema.parse({ ...valid, website: 'http://example.com' }).website).toBe('http://example.com')
    })

    it('rejects web addresses over 200 characters', () => {
        expect(errorsFor({ ...valid, website: `https://example.com/${'a'.repeat(190)}` })).toEqual({ website: 'Keep links under 200 characters' })
    })

    it('accepts up to 5 reference sites, each a web address', () => {
        const five = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`)
        expect(quoteSchema.parse({ ...valid, referenceSites: five }).referenceSites).toEqual(five)
        expect(errorsFor({ ...valid, referenceSites: [...five, 'https://example.com/6'] })).toEqual({ referenceSites: 'Up to 5 links' })
        expect(errorsFor({ ...valid, referenceSites: ['javascript:alert(1)'] })).toEqual({ referenceSites: 'Enter a full web address, starting with https://' })
    })

    it('rejects options it does not offer', () => {
        expect(errorsFor({ ...valid, projectType: 'CASTLE', budget: 'MILLIONS', timeline: 'YESTERDAY' })).toEqual({
            projectType: 'Choose one of the options',
            budget: 'Choose one of the options',
            timeline: 'Choose one of the options',
        })
    })

    it('drops fields it does not know, such as the spam check fields', () => {
        expect(quoteSchema.parse({ ...valid, fax: 'x', turnstileToken: 'y' })).not.toHaveProperty('fax')
    })
})
