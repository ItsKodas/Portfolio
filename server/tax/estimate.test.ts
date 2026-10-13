import { describe, expect, it } from 'vitest'

import { estimate, incomeTax, lowIncomeOffset, medicareLevy, smallBusinessOffset } from './estimate'

const dollars = (n: number) => Math.round(n * 100)

describe('income tax', () => {
    it('is nothing up to the tax-free threshold', () => {
        expect(incomeTax(dollars(18_200), 2027)).toBe(0)
    })

    it('uses the rates of the year: 16% to 2025-26, 15% in 2026-27 and 14% after', () => {
        expect(incomeTax(dollars(45_000), 2026)).toBe(dollars(4_288))
        expect(incomeTax(dollars(45_000), 2027)).toBe(dollars(4_020))
        expect(incomeTax(dollars(45_000), 2028)).toBe(dollars(3_752))
        expect(incomeTax(dollars(45_000), 2035)).toBe(dollars(3_752))
    })

    it('climbs through the higher brackets', () => {
        expect(incomeTax(dollars(135_000), 2027)).toBe(dollars(31_020))
        expect(incomeTax(dollars(190_000), 2027)).toBe(dollars(51_370))
        expect(incomeTax(dollars(200_000), 2027)).toBe(dollars(55_870))
    })
})

describe('offsets and the Medicare levy', () => {
    it('gives the full low income offset to $37,500 and none from $66,667', () => {
        expect(lowIncomeOffset(dollars(30_000))).toBe(dollars(700))
        expect(lowIncomeOffset(dollars(45_000))).toBe(dollars(325))
        expect(lowIncomeOffset(dollars(66_667))).toBe(0)
    })

    it('phases the levy in above the low-income threshold', () => {
        expect(medicareLevy(dollars(27_000))).toBe(0)
        expect(medicareLevy(dollars(30_000))).toBe(dollars(277.8))
        expect(medicareLevy(dollars(50_000))).toBe(dollars(1_000))
    })

    it('caps the small business offset at $1,000', () => {
        expect(smallBusinessOffset(dollars(5_000), dollars(50_000), dollars(50_000))).toBe(dollars(800))
        expect(smallBusinessOffset(dollars(5_000), dollars(25_000), dollars(50_000))).toBe(dollars(400))
        expect(smallBusinessOffset(dollars(40_000), dollars(150_000), dollars(150_000))).toBe(dollars(1_000))
    })
})

describe('the estimate', () => {
    it('adds it up for a sole trader with only business income', () => {
        const result = estimate({ businessCents: dollars(50_000), otherCents: 0, withheldCents: 0 }, 2027)
        expect(result.incomeTaxCents).toBe(dollars(5_520))
        expect(result.lowIncomeOffsetCents).toBe(dollars(250))
        expect(result.smallBusinessOffsetCents).toBe(dollars(883.2))
        expect(result.medicareCents).toBe(dollars(1_000))
        expect(result.totalCents).toBe(dollars(5_386.8))
        expect(result.owingCents).toBe(result.totalCents)
        expect(result.businessShareCents).toBe(result.totalCents)
    })

    it('owes nothing below the thresholds', () => {
        const result = estimate({ businessCents: dollars(15_000), otherCents: 0, withheldCents: 0 }, 2027)
        expect(result.totalCents).toBe(0)
        expect(result.rate).toBe(0)
    })

    it('counts the business on top of other income, and takes off tax already paid', () => {
        const result = estimate({ businessCents: dollars(10_000), otherCents: dollars(60_000), withheldCents: dollars(9_000) }, 2027)
        const wagesOnly = estimate({ businessCents: 0, otherCents: dollars(60_000), withheldCents: 0 }, 2027)
        expect(result.taxableCents).toBe(dollars(70_000))
        expect(result.businessShareCents).toBe(result.totalCents - wagesOnly.totalCents)
        expect(result.owingCents).toBe(Math.max(0, result.totalCents - dollars(9_000)))
    })

    it('never turns a business loss into a refund', () => {
        const result = estimate({ businessCents: -dollars(5_000), otherCents: dollars(60_000), withheldCents: 0 }, 2027)
        expect(result.businessCents).toBe(0)
        expect(result.taxableCents).toBe(dollars(60_000))
    })
})
