import { describe, expect, it } from 'vitest'

import type { Domain } from '@/server/hostd/domains'
import { stateWord, stateTone, clientSentence, needsYou, sortDomains } from './domains'

const domain = (over: Partial<Domain> = {}): Domain => ({
    hostname: 'acme.com', primary: true, state: 'active', certificate: 'cloudflare-origin',
    checkedAt: '2026-09-21T00:00:00.000Z', error: null, vhost: null, ...over,
})

describe('stateWord', () => {
    it('says what each state means in the operator\'s language', () => {
        expect(stateWord('active')).toBe('working')
        expect(stateWord('pending')).toBe('waiting for DNS')
        expect(stateWord('broken')).toBe('stopped answering')
        expect(stateWord('failed')).toBe('gave up')
        expect(stateWord('unmanaged')).toBe('set up by hand')
    })
})

describe('stateTone', () => {
    it('makes a broken domain critical and a pending one merely warm', () => {
        expect(stateTone('broken')).toBe('crit')
        expect(stateTone('pending')).toBe('warn')
        expect(stateTone('active')).toBe('good')
    })

    it('leaves an unmanaged domain neutral, because it is not a fault', () => {
        expect(stateTone('unmanaged')).toBe('idle')
    })
})

describe('clientSentence', () => {
    it('tells a client a working domain is working, without jargon', () => {
        const said = clientSentence(domain())
        expect(said).toMatch(/working/)
        expect(said).not.toMatch(/vhost|Apache|127\.0\.0\.1|proxy pass/i)
    })

    it('passes hostd\'s own explanation through when there is one', () => {
        expect(clientSentence(domain({ state: 'pending', error: 'No record exists yet. Add the CNAME.' })))
            .toMatch(/No record exists yet/)
    })

    it('says something useful about a broken domain even when hostd gave no reason', () => {
        expect(clientSentence(domain({ state: 'broken', error: null }))).toMatch(/looking into it/)
    })

    it('never shows a client a file path, whatever hostd said', () => {
        const said = clientSentence(domain({ state: 'broken', error: '/etc/apache2/sites-enabled/acme.conf is wrong' }))
        expect(said).not.toMatch(/\/etc\//)
    })

    // Nothing alarming, because nothing is wrong with one, and no claim that it works either: hostd has
    // never checked an unmanaged address, and telling a client it is working is a check we did not make.
    it('says an unmanaged domain is set up, without claiming a check nobody made', () => {
        const said = clientSentence(domain({ state: 'unmanaged' }))
        expect(said).toMatch(/set up/)
        expect(said).not.toMatch(/working/)
    })
})

describe('needsYou', () => {
    it('is true only for the states an operator has to act on', () => {
        expect(needsYou(domain({ state: 'broken' }))).toBe(true)
        expect(needsYou(domain({ state: 'failed' }))).toBe(true)
        expect(needsYou(domain({ state: 'active' }))).toBe(false)
        expect(needsYou(domain({ state: 'pending' }))).toBe(false)
        expect(needsYou(domain({ state: 'unmanaged' }))).toBe(false)
    })

    it('is true when the vhost was rolled back, whatever the domain\'s own state says', () => {
        expect(needsYou(domain({ state: 'active', vhost: { ok: false, output: 'AH00526' } }))).toBe(true)
    })
})

describe('sortDomains', () => {
    it('puts the primary first and then sorts by name, so the table never reorders itself', () => {
        const sorted = sortDomains([
            domain({ hostname: 'www.acme.com', primary: false }),
            domain({ hostname: 'acme.com', primary: true }),
            domain({ hostname: 'shop.acme.com', primary: false }),
        ])
        expect(sorted.map(d => d.hostname)).toEqual(['acme.com', 'shop.acme.com', 'www.acme.com'])
    })
})
