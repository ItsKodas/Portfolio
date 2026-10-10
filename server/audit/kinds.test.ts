import { describe, expect, it } from 'vitest'

import { CATEGORIES, KINDS, categoryOf, isCategory, kindLabel } from './kinds'

describe('KINDS', () => {
    it('puts every kind in one of the categories the page filters by', () => {
        for (const kind of Object.keys(KINDS)) expect(categoryOf(kind), kind).not.toBeNull()
    })

    it('gives every category at least one kind, so no filter is always empty', () => {
        for (const category of Object.keys(CATEGORIES)) {
            expect(Object.keys(KINDS).some(kind => categoryOf(kind) === category), category).toBe(true)
        }
    })
})

describe('isCategory', () => {
    it('does not accept what every object has', () => {
        expect(isCategory('toString')).toBe(false)
        expect(isCategory('__proto__')).toBe(false)
        expect(isCategory('site')).toBe(true)
    })
})

describe('kindLabel', () => {
    it('says a kind in words, and an unknown one as itself', () => {
        expect(kindLabel('deploy.start')).toBe('Deploy started')
        expect(kindLabel('site.teleport')).toBe('site.teleport')
        expect(kindLabel('constructor')).toBe('constructor')
    })
})
