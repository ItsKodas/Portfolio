// Amounts in whole cents, and the arithmetic an invoice needs. Plain logic, so the form in the browser, the
// server that saves it and the PDF all add up a line the same way.

export const GST_RATE = 0.1

export type LineInput = { description: string, quantity: number, unitCents: number }

// The one place a quantity's float meets money: rounded to the cent once, and never again
export const lineAmount = (line: { quantity: number, unitCents: number }): number => Math.round(line.quantity * line.unitCents)

export type Totals = { subtotalCents: number, gstCents: number, totalCents: number }

// GST on the subtotal rather than per line, which is how the ATO's own examples round it
export function totalsOf(lines: { quantity: number, unitCents: number }[], gst: boolean): Totals {
    const subtotalCents = lines.reduce((sum, line) => sum + lineAmount(line), 0)
    const gstCents = gst ? Math.round(subtotalCents * GST_RATE) : 0
    return { subtotalCents, gstCents, totalCents: subtotalCents + gstCents }
}

const formatter = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', currencyDisplay: 'narrowSymbol' })

// "$1,250.00". The currency is named once on an invoice, beside its total, rather than on every figure.
export function formatMoney(cents: number, currency = 'AUD'): string {
    if (currency === 'AUD') return formatter.format(cents / 100)
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(cents / 100)
}

// What PayPal wants: "1250.00", a string with exactly two places
export const paypalValue = (cents: number): string => {
    const sign = cents < 0 ? '-' : ''
    const abs = Math.abs(cents)
    return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

// And back. Null for anything that is not a plain amount, so a payment PayPal reports oddly is never
// read as some other number.
export function centsFromValue(value: unknown): number | null {
    if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value)) return null
    const [whole, fraction = ''] = value.split('.')
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

// What a person types into a price box: "1250", "1,250.50", "$99". Null when it is not an amount.
export function parseDollars(text: string): number | null {
    const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '')
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
    return centsFromValue(cleaned)
}

// The other way, for filling a form back in: no symbol, no thousands separator
export const dollarsText = (cents: number): string => (cents % 100 === 0 ? String(cents / 100) : paypalValue(cents))

export const formatQuantity = (quantity: number): string =>
    Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2).replace(/0$/, '')
