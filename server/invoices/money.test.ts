import { describe, expect, it } from 'vitest'

import { centsFromValue, dollarsText, formatMoney, formatQuantity, lineAmount, parseDollars, paypalValue, totalsOf } from './money'

describe('totalsOf', () => {
    it('adds the lines and rounds each to the cent once', () => {
        expect(lineAmount({ quantity: 1.5, unitCents: 9_999 })).toBe(14_999)
        expect(totalsOf([{ quantity: 2, unitCents: 5_000 }, { quantity: 1.5, unitCents: 9_999 }], false))
            .toEqual({ subtotalCents: 24_999, gstCents: 0, totalCents: 24_999 })
    })

    it('adds GST on the subtotal when it is charged', () => {
        expect(totalsOf([{ quantity: 1, unitCents: 4_995 }], true)).toEqual({ subtotalCents: 4_995, gstCents: 500, totalCents: 5_495 })
    })
})

describe('PayPal amounts', () => {
    it('writes two places, always', () => {
        expect(paypalValue(125_000)).toBe('1250.00')
        expect(paypalValue(5)).toBe('0.05')
        expect(paypalValue(4_995)).toBe('49.95')
    })

    it('reads them back, and refuses anything odd', () => {
        expect(centsFromValue('1250.00')).toBe(125_000)
        expect(centsFromValue('49.9')).toBe(4_990)
        expect(centsFromValue('12')).toBe(1_200)
        expect(centsFromValue('-1.00')).toBeNull()
        expect(centsFromValue('1e3')).toBeNull()
        expect(centsFromValue(12)).toBeNull()
    })
})

describe('parseDollars', () => {
    it('takes what a person types', () => {
        expect(parseDollars('1,250.50')).toBe(125_050)
        expect(parseDollars('$99')).toBe(9_900)
        expect(parseDollars(' 0 ')).toBe(0)
    })

    it('refuses what is not an amount', () => {
        expect(parseDollars('')).toBeNull()
        expect(parseDollars('12.345')).toBeNull()
        expect(parseDollars('ten')).toBeNull()
        expect(parseDollars('-5')).toBeNull()
    })

    it('round-trips through the form', () => {
        expect(dollarsText(9_900)).toBe('99')
        expect(dollarsText(4_995)).toBe('49.95')
        expect(parseDollars(dollarsText(4_995))).toBe(4_995)
    })
})

describe('formatting', () => {
    it('shows dollars and quantities plainly', () => {
        expect(formatMoney(125_000)).toBe('$1,250.00')
        expect(formatQuantity(2)).toBe('2')
        expect(formatQuantity(1.5)).toBe('1.5')
        expect(formatQuantity(1.25)).toBe('1.25')
    })
})
