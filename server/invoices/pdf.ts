// The invoice as a PDF: what the client downloads from the portal and what the invoice email carries. Drawn
// with pdf-lib's built-in Helvetica, so there is no font file to ship and no browser to run. A4, black on white,
// because it is printed and filed far more often than it is looked at on a screen.

import 'server-only'

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

import type { Business } from './business'
import { formatDay, type Day } from './days'
import { formatMoney, formatQuantity, GST_RATE } from './money'
import { invoiceNumber, type Standing } from './standing'

export type PdfInvoice = {
    number: number | null
    standing: Standing
    issuedOn: Day | null
    dueOn: Day
    billToName: string
    billToCompany: string | null
    billToEmail: string
    currency: string
    gst: boolean
    lines: { description: string, quantity: number, unitCents: number, amountCents: number }[]
    subtotalCents: number
    gstCents: number
    totalCents: number
    paidCents: number
    paidOn: Day | null
    notes: string | null
    periodStart: Day | null
    periodEnd: Day | null
}

const A4 = { width: 595.28, height: 841.89 }
const MARGIN = 50
const RIGHT = A4.width - MARGIN
const BOTTOM = 70

const INK = rgb(0.1, 0.11, 0.14)
const MUTED = rgb(0.42, 0.44, 0.49)
const RULE = rgb(0.85, 0.86, 0.88)
const ACCENT = rgb(0.18, 0.5, 0.68)
const STAMP: Partial<Record<Standing, ReturnType<typeof rgb>>> = {
    paid: rgb(0.2, 0.6, 0.38),
    void: rgb(0.78, 0.27, 0.23),
    overdue: rgb(0.78, 0.27, 0.23),
    draft: MUTED,
}

// The columns of the lines table, by their right edge (the description's is its left)
const COLUMNS = { description: MARGIN, quantity: 360, unit: 460, amount: RIGHT }
const DESCRIPTION_WIDTH = 290

type Fonts = { regular: PDFFont, bold: PDFFont }

// Helvetica here speaks WinAnsi, which covers English and most of Western Europe. Anything else (an emoji, a
// Chinese name) is swapped for a question mark rather than stopping the whole invoice from being drawn.
function safe(font: PDFFont, text: string): string {
    let out = ''
    for (const char of text.replace(/\t/g, ' ')) {
        try {
            font.encodeText(char)
            out += char
        } catch {
            out += '?'
        }
    }
    return out
}

// Words onto lines no wider than width, breaking a word only when it is wider than a line on its own
function wrap(font: PDFFont, size: number, text: string, width: number): string[] {
    const lines: string[] = []
    for (const paragraph of safe(font, text).split(/\r?\n/)) {
        let line = ''
        for (const word of paragraph.split(/ +/)) {
            const candidate = line ? `${line} ${word}` : word
            if (font.widthOfTextAtSize(candidate, size) <= width) {
                line = candidate
                continue
            }
            if (line) lines.push(line)
            line = ''
            let rest = word
            while (font.widthOfTextAtSize(rest, size) > width) {
                let cut = rest.length - 1
                while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--
                lines.push(rest.slice(0, cut))
                rest = rest.slice(cut)
            }
            line = rest
        }
        lines.push(line)
    }
    return lines
}

export async function invoicePdf(invoice: PdfInvoice, business: Business, options: { payUrl: string }): Promise<Buffer> {
    const pdf = await PDFDocument.create()
    const number = invoiceNumber(invoice.number)
    const title = invoice.gst ? 'Tax invoice' : 'Invoice'
    pdf.setTitle(`${title} ${number}`)
    pdf.setAuthor(business.name)
    pdf.setSubject(`${title} ${number} for ${invoice.billToName}`)
    pdf.setCreator(business.name)
    pdf.setProducer(business.name)

    const fonts: Fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) }

    let page = pdf.addPage([A4.width, A4.height])
    let y = A4.height - MARGIN

    const text = (value: string, x: number, at: number, style: { size?: number, bold?: boolean, color?: ReturnType<typeof rgb>, align?: 'left' | 'right' } = {}) => {
        const font = style.bold ? fonts.bold : fonts.regular
        const size = style.size ?? 10
        const clean = safe(font, value)
        const left = style.align === 'right' ? x - font.widthOfTextAtSize(clean, size) : x
        page.drawText(clean, { x: left, y: at, size, font, color: style.color ?? INK })
    }
    const rule = (at: number, from = MARGIN, to = RIGHT) =>
        page.drawLine({ start: { x: from, y: at }, end: { x: to, y: at }, thickness: 0.75, color: RULE })

    // The business, top left. No logo: the site's is drawn light for a dark page, and vanishes on paper.
    text(business.name, MARGIN, y - 20, { size: 16, bold: true })
    let fromY = y - 48
    const fromLines = [`ABN ${business.abn}`, ...business.address, business.email, business.website.replace(/^https?:\/\//, '')]
    for (const line of fromLines) {
        text(line, MARGIN, fromY, { size: 9, color: MUTED })
        fromY -= 13
    }

    // The invoice's own facts, top right
    text(title.toUpperCase(), RIGHT, y - 20, { size: 20, bold: true, color: ACCENT, align: 'right' })
    const facts: [string, string][] = [
        ['Number', number],
        ['Issued', invoice.issuedOn ? formatDay(invoice.issuedOn) : 'Not yet sent'],
        ['Due', formatDay(invoice.dueOn)],
    ]
    let factY = y - 48
    for (const [label, value] of facts) {
        text(label, RIGHT - 130, factY, { size: 9, color: MUTED })
        text(value, RIGHT, factY, { size: 9, bold: true, align: 'right' })
        factY -= 13
    }
    const stamp = STAMP[invoice.standing]
    if (stamp) {
        const word = invoice.standing.toUpperCase()
        const width = fonts.bold.widthOfTextAtSize(word, 11) + 16
        page.drawRectangle({ x: RIGHT - width, y: factY - 12, width, height: 20, borderColor: stamp, borderWidth: 1.25 })
        text(word, RIGHT - 8, factY - 6, { size: 11, bold: true, color: stamp, align: 'right' })
        factY -= 24
    }

    y = Math.min(fromY, factY) - 18

    // Who it is for
    text('BILL TO', MARGIN, y, { size: 8, bold: true, color: MUTED })
    y -= 15
    text(invoice.billToName, MARGIN, y, { size: 11, bold: true })
    y -= 14
    if (invoice.billToCompany) {
        text(invoice.billToCompany, MARGIN, y, { size: 10 })
        y -= 13
    }
    text(invoice.billToEmail, MARGIN, y, { size: 10, color: MUTED })
    y -= 13
    if (invoice.periodStart && invoice.periodEnd) {
        y -= 6
        text(`Service period: ${formatDay(invoice.periodStart)} to ${formatDay(invoice.periodEnd)}`, MARGIN, y, { size: 9, color: MUTED })
        y -= 13
    }

    y -= 18
    const tableHead = () => {
        text('DESCRIPTION', COLUMNS.description, y, { size: 8, bold: true, color: MUTED })
        text('QTY', COLUMNS.quantity, y, { size: 8, bold: true, color: MUTED, align: 'right' })
        text('UNIT PRICE', COLUMNS.unit, y, { size: 8, bold: true, color: MUTED, align: 'right' })
        text('AMOUNT', COLUMNS.amount, y, { size: 8, bold: true, color: MUTED, align: 'right' })
        y -= 8
        rule(y)
        y -= 16
    }
    const newPage = () => {
        page = pdf.addPage([A4.width, A4.height])
        y = A4.height - MARGIN
        text(`${title} ${number} (continued)`, MARGIN, y, { size: 9, color: MUTED })
        y -= 28
    }
    tableHead()

    for (const line of invoice.lines) {
        const wrapped = wrap(fonts.regular, 10, line.description, DESCRIPTION_WIDTH)
        const height = wrapped.length * 13 + 8
        if (y - height < BOTTOM + 20) {
            newPage()
            tableHead()
        }
        text(formatQuantity(line.quantity), COLUMNS.quantity, y, { align: 'right' })
        text(formatMoney(line.unitCents, invoice.currency), COLUMNS.unit, y, { align: 'right' })
        text(formatMoney(line.amountCents, invoice.currency), COLUMNS.amount, y, { align: 'right' })
        for (const part of wrapped) {
            text(part, COLUMNS.description, y)
            y -= 13
        }
        y -= 4
        rule(y + 6)
        y -= 6
    }

    // The totals, right aligned under the amounts
    const balance = Math.max(0, invoice.totalCents - invoice.paidCents)
    const totals: { label: string, value: string, strong?: boolean }[] = [{ label: 'Subtotal', value: formatMoney(invoice.subtotalCents, invoice.currency) }]
    if (invoice.gst) totals.push({ label: `GST (${GST_RATE * 100}%)`, value: formatMoney(invoice.gstCents, invoice.currency) })
    totals.push({ label: `Total (${invoice.currency})`, value: formatMoney(invoice.totalCents, invoice.currency), strong: true })
    if (invoice.paidCents > 0) {
        totals.push({ label: invoice.paidOn ? `Paid ${formatDay(invoice.paidOn)}` : 'Paid', value: `-${formatMoney(invoice.paidCents, invoice.currency)}` })
    }
    if (invoice.standing !== 'void') totals.push({ label: 'Balance due', value: formatMoney(balance, invoice.currency), strong: true })

    if (y - totals.length * 18 - 40 < BOTTOM) newPage()
    y -= 6
    for (const row of totals) {
        text(row.label, COLUMNS.unit, y, { size: row.strong ? 11 : 10, bold: row.strong, color: row.strong ? INK : MUTED, align: 'right' })
        text(row.value, COLUMNS.amount, y, { size: row.strong ? 11 : 10, bold: row.strong, align: 'right' })
        y -= 18
    }
    if (!invoice.gst) {
        text('No GST has been charged.', COLUMNS.amount, y, { size: 8, color: MUTED, align: 'right' })
        y -= 14
    }

    const block = (heading: string, body: string) => {
        const lines = wrap(fonts.regular, 9.5, body, RIGHT - MARGIN)
        if (y - 30 - lines.length * 13 < BOTTOM) newPage()
        y -= 18
        text(heading, MARGIN, y, { size: 8, bold: true, color: MUTED })
        y -= 15
        for (const line of lines) {
            text(line, MARGIN, y, { size: 9.5 })
            y -= 13
        }
    }

    if (invoice.notes) block('NOTES', invoice.notes)
    if (invoice.standing === 'due' || invoice.standing === 'overdue') {
        block('HOW TO PAY', `Pay online with PayPal or a card at ${options.payUrl}. Please pay by ${formatDay(invoice.dueOn)}, and quote ${number} with any other kind of payment.`)
    }

    // A footer on every page, numbered now that the count is known
    const pages = pdf.getPages()
    pages.forEach((each, index) => {
        page = each
        rule(BOTTOM - 22)
        text(`${business.name}  ·  ABN ${business.abn}  ·  ${business.email}`, MARGIN, BOTTOM - 36, { size: 8, color: MUTED })
        text(`${number}  ·  Page ${index + 1} of ${pages.length}`, RIGHT, BOTTOM - 36, { size: 8, color: MUTED, align: 'right' })
    })

    return Buffer.from(await pdf.save())
}
