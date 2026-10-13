// A rough income tax figure for an Australian resident sole trader, so there is a number to put money aside
// against through the year. It is an estimate and the page says so: it leaves out anything the portal can't
// know (private health cover and the Medicare levy surcharge, HELP debts, other offsets and deductions), and
// the return is what decides the real figure. Whole cents throughout, dollars only in the rate tables.

import type { FinancialYear } from './year'

type Bracket = { from: number, rate: number }

// Resident rates by the year they apply to. The 16% rate falls to 15% from 1 July 2026 and 14% from 1 July
// 2027 (the 2025 Budget cuts, now law). A year past the last listed uses the last one.
const RATES: { year: FinancialYear, brackets: Bracket[] }[] = [
    { year: 2025, brackets: [{ from: 18_200, rate: 0.16 }, { from: 45_000, rate: 0.30 }, { from: 135_000, rate: 0.37 }, { from: 190_000, rate: 0.45 }] },
    { year: 2027, brackets: [{ from: 18_200, rate: 0.15 }, { from: 45_000, rate: 0.30 }, { from: 135_000, rate: 0.37 }, { from: 190_000, rate: 0.45 }] },
    { year: 2028, brackets: [{ from: 18_200, rate: 0.14 }, { from: 45_000, rate: 0.30 }, { from: 135_000, rate: 0.37 }, { from: 190_000, rate: 0.45 }] },
]

export const TAX_FREE_THRESHOLD = 18_200

function bracketsFor(year: FinancialYear): Bracket[] {
    let chosen = RATES[0]
    for (const entry of RATES) if (entry.year <= year) chosen = entry
    return chosen.brackets
}

export function incomeTax(taxableCents: number, year: FinancialYear): number {
    const income = Math.max(0, taxableCents) / 100
    const brackets = bracketsFor(year)
    let tax = 0
    brackets.forEach((bracket, index) => {
        const to = brackets[index + 1]?.from ?? Infinity
        if (income > bracket.from) tax += (Math.min(income, to) - bracket.from) * bracket.rate
    })
    return Math.round(tax * 100)
}

// Low income tax offset: $700, less 5c in the dollar from $37,500 to $45,000, then 1.5c until it runs out
export function lowIncomeOffset(taxableCents: number): number {
    const income = Math.max(0, taxableCents) / 100
    let offset = 700
    if (income > 37_500) offset -= (Math.min(income, 45_000) - 37_500) * 0.05
    if (income > 45_000) offset -= (income - 45_000) * 0.015
    return Math.round(Math.max(0, offset) * 100)
}

// The Medicare levy is 2%, phased in above the low-income threshold for a single person at 10c in the dollar
// until that reaches 2% of the whole income
const MEDICARE_RATE = 0.02
export const MEDICARE_LOW_INCOME = 27_222

export function medicareLevy(taxableCents: number): number {
    const income = Math.max(0, taxableCents) / 100
    if (income <= MEDICARE_LOW_INCOME) return 0
    return Math.round(Math.min(income * MEDICARE_RATE, (income - MEDICARE_LOW_INCOME) * 0.1) * 100)
}

// Small business income tax offset: 16% of the tax on the business's share of the income, at most $1,000
export function smallBusinessOffset(basicTaxCents: number, businessCents: number, taxableCents: number): number {
    if (basicTaxCents <= 0 || businessCents <= 0 || taxableCents <= 0) return 0
    const share = Math.min(1, businessCents / taxableCents)
    return Math.min(100_000, Math.round(basicTaxCents * share * 0.16))
}

export type Estimate = {
    businessCents: number
    otherCents: number
    taxableCents: number
    incomeTaxCents: number
    lowIncomeOffsetCents: number
    smallBusinessOffsetCents: number
    medicareCents: number
    totalCents: number
    withheldCents: number
    // What is left to pay once the return is assessed, never below zero (a refund is shown as zero owing)
    owingCents: number
    // The part of the total the business adds, over what the other income alone would cost: the amount to
    // put aside from the business's own money
    businessShareCents: number
    // Average rate on the whole taxable income
    rate: number
}

function totalTax(businessCents: number, otherCents: number, year: FinancialYear) {
    const taxableCents = Math.max(0, businessCents) + Math.max(0, otherCents)
    const incomeTaxCents = incomeTax(taxableCents, year)
    const lowIncomeOffsetCents = Math.min(incomeTaxCents, lowIncomeOffset(taxableCents))
    const smallBusinessOffsetCents = Math.min(
        incomeTaxCents - lowIncomeOffsetCents,
        smallBusinessOffset(incomeTaxCents, Math.max(0, businessCents), taxableCents),
    )
    const medicareCents = medicareLevy(taxableCents)
    return {
        taxableCents, incomeTaxCents, lowIncomeOffsetCents, smallBusinessOffsetCents, medicareCents,
        totalCents: incomeTaxCents - lowIncomeOffsetCents - smallBusinessOffsetCents + medicareCents,
    }
}

// A business loss is counted as nothing here rather than taken off the other income: the non-commercial loss
// rules usually stop a small sole trader doing that, and an estimate should not promise a refund it can't know of
export function estimate(input: { businessCents: number, otherCents: number, withheldCents: number }, year: FinancialYear): Estimate {
    const business = Math.max(0, input.businessCents)
    const other = Math.max(0, input.otherCents)
    const all = totalTax(business, other, year)
    const otherOnly = totalTax(0, other, year)
    return {
        ...all,
        businessCents: business,
        otherCents: other,
        withheldCents: Math.max(0, input.withheldCents),
        owingCents: Math.max(0, all.totalCents - Math.max(0, input.withheldCents)),
        businessShareCents: Math.max(0, all.totalCents - otherOnly.totalCents),
        rate: all.taxableCents ? all.totalCents / all.taxableCents : 0,
    }
}

// GST registration is required once turnover reaches this over twelve months, current or projected
export const GST_THRESHOLD_CENTS = 75_000_00
// Where the page and the reminders start warning about it
export const GST_NEAR_CENTS = 60_000_00
