// The invoice as a PDF: what the client downloads from the portal and what the invoice email carries. Drawn
// with pdf-lib's built-in Helvetica, so there is no font file to ship and no browser to run. A4, in the portal's
// own dark palette (ui/tokens.css), so the invoice reads as the same product as the site that sent it.

import 'server-only'

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib'

import type { Business } from './business'
import { formatDay, formatDayShort, type Day } from './days'
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
const MARGIN = 44
const RIGHT = A4.width - MARGIN
const WIDTH = RIGHT - MARGIN
const BOTTOM = 76

const hex = (value: string) => {
    const n = parseInt(value.slice(1), 16)
    return { r: (n >> 16) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}
const color = (value: string) => {
    const c = hex(value)
    return rgb(c.r, c.g, c.b)
}
// One colour laid over another at a strength, for tints that pdf-lib cannot do with transparency on every reader
const mix = (top: string, under: string, strength: number) => {
    const a = hex(top), b = hex(under)
    return rgb(b.r + (a.r - b.r) * strength, b.g + (a.g - b.g) * strength, b.b + (a.b - b.b) * strength)
}

// ui/tokens.css
const NIGHT = '#0c0d10'
const PAGE = color(NIGHT)
const PANEL = color('#14161b')
const PANEL_HI = color('#1b1e24')
const RULE = color('#23262d')
const INK = color('#e8eaee')
const INK_2 = color('#9ba1ad')
const INK_3 = color('#6b717d')
const LAKE = color('#8fd4f5')
const LAKE_TINT = mix('#8fd4f5', NIGHT, 0.12)

const TONES: Record<Standing, { label: string, ink: RGB, fill: RGB }> = {
    draft: { label: 'Draft', ink: INK_2, fill: mix('#9ba1ad', NIGHT, 0.14) },
    due: { label: 'Due', ink: LAKE, fill: mix('#8fd4f5', NIGHT, 0.14) },
    overdue: { label: 'Overdue', ink: color('#ea6d63'), fill: mix('#e4574c', NIGHT, 0.18) },
    paid: { label: 'Paid', ink: color('#5fc98d'), fill: mix('#5fc98d', NIGHT, 0.16) },
    void: { label: 'Void', ink: color('#ea6d63'), fill: mix('#e4574c', NIGHT, 0.18) },
}

// The columns of the lines table, by their right edge (the description's is its left)
const COLUMNS = { description: MARGIN + 14, quantity: 362, unit: 452, amount: RIGHT - 14 }
const DESCRIPTION_WIDTH = 270

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

// Shortened with an ellipsis to fit, for the boxes that have room for one line only
function fit(font: PDFFont, size: number, text: string, width: number): string {
    const clean = safe(font, text)
    if (font.widthOfTextAtSize(clean, size) <= width) return clean
    let cut = clean.length
    while (cut > 1 && font.widthOfTextAtSize(`${clean.slice(0, cut)}...`, size) > width) cut--
    return `${clean.slice(0, cut)}...`
}

type Style = { size?: number, bold?: boolean, color?: RGB, align?: 'left' | 'right', tracking?: number }

export async function invoicePdf(invoice: PdfInvoice, business: Business, options: { payUrl: string, logo?: Uint8Array | null }): Promise<Buffer> {
    const pdf = await PDFDocument.create()
    const number = invoiceNumber(invoice.number)
    const title = invoice.gst ? 'Tax invoice' : 'Invoice'
    pdf.setTitle(`${title} ${number}`)
    pdf.setAuthor(business.name)
    pdf.setSubject(`${title} ${number} for ${invoice.billToName}`)
    pdf.setCreator(business.name)
    pdf.setProducer(business.name)

    const fonts: Fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) }
    let logo: PDFImage | null = null
    if (options.logo) {
        try {
            logo = await pdf.embedPng(options.logo)
        } catch {
            logo = null
        }
    }

    let page!: PDFPage
    let y = 0

    const widthOf = (value: string, style: Style = {}) => {
        const font = style.bold ? fonts.bold : fonts.regular
        const size = style.size ?? 10
        const clean = safe(font, value)
        return font.widthOfTextAtSize(clean, size) + (style.tracking ?? 0) * Math.max(0, clean.length - 1)
    }
    // Tracked text is drawn a letter at a time, since pdf-lib has no letter spacing of its own
    const text = (value: string, x: number, at: number, style: Style = {}) => {
        const font = style.bold ? fonts.bold : fonts.regular
        const size = style.size ?? 10
        const clean = safe(font, value)
        const left = style.align === 'right' ? x - widthOf(value, style) : x
        const ink = style.color ?? INK
        if (!style.tracking) {
            page.drawText(clean, { x: left, y: at, size, font, color: ink })
            return
        }
        let cursor = left
        for (const char of clean) {
            page.drawText(char, { x: cursor, y: at, size, font, color: ink })
            cursor += font.widthOfTextAtSize(char, size) + style.tracking
        }
    }
    const label = (value: string, x: number, at: number, style: Style = {}) =>
        text(value.toUpperCase(), x, at, { size: 7, bold: true, color: INK_3, tracking: 1.1, ...style })
    const rule = (at: number, from = MARGIN, to = RIGHT, ink = RULE) =>
        page.drawLine({ start: { x: from, y: at }, end: { x: to, y: at }, thickness: 0.75, color: ink })
    // A rounded box, by its bottom left corner
    const box = (x: number, bottom: number, width: number, height: number, fill: RGB, radius = 8, border?: RGB) => {
        const r = Math.min(radius, width / 2, height / 2)
        const path = `M ${r} 0 H ${width - r} A ${r} ${r} 0 0 1 ${width} ${r} V ${height - r} A ${r} ${r} 0 0 1 ${width - r} ${height}`
            + ` H ${r} A ${r} ${r} 0 0 1 0 ${height - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`
        page.drawSvgPath(path, { x, y: bottom + height, color: fill, ...(border && { borderColor: border, borderWidth: 0.75 }) })
    }
    const pill = (standing: Standing, right: number, top: number) => {
        const tone = TONES[standing]
        const style: Style = { size: 7.5, bold: true, color: tone.ink, tracking: 1 }
        const word = tone.label.toUpperCase()
        const width = widthOf(word, style) + 26
        box(right - width, top - 17, width, 17, tone.fill, 8.5)
        page.drawCircle({ x: right - width + 10, y: top - 8.5, size: 2.2, color: tone.ink })
        text(word, right - 9, top - 11.5, { ...style, align: 'right' })
    }

    const addPage = () => {
        page = pdf.addPage([A4.width, A4.height])
        page.drawRectangle({ x: 0, y: 0, width: A4.width, height: A4.height, color: PAGE })
        page.drawRectangle({ x: 0, y: A4.height - 3, width: A4.width, height: 3, color: LAKE })
        y = A4.height - MARGIN
    }
    const continued = () => {
        addPage()
        label(`${title} ${number}`, MARGIN, y - 6, { color: INK_2 })
        label('Continued', RIGHT, y - 6, { align: 'right' })
        y -= 30
    }

    addPage()

    // The business, top left: the mark, the name set the way the site sets it, and how to reach it
    const top = y
    let nameX = MARGIN
    if (logo) {
        page.drawImage(logo, { x: MARGIN, y: top - 42, width: 42, height: 42 })
        nameX = MARGIN + 56
    }
    text(business.name.toUpperCase(), nameX, top - 17, { size: 15, bold: true, tracking: 3.2 })
    text(business.website.replace(/^https?:\/\//, ''), nameX, top - 33, { size: 9, color: INK_2 })
    text(`ABN ${business.abn}`, nameX, top - 45, { size: 9, color: INK_3 })
    let fromY = top - 45
    for (const line of business.address) {
        fromY -= 12
        text(line, nameX, fromY, { size: 9, color: INK_3 })
    }

    // The invoice's own name and number, top right
    label(title, RIGHT, top - 9, { color: LAKE, size: 8, tracking: 2.2, align: 'right' })
    text(number, RIGHT, top - 36, { size: 26, bold: true, align: 'right' })

    y = Math.min(top - 66, fromY - 18)
    rule(y)
    y -= 18

    // Three boxes: who it is for, when, and how much
    const gap = 10
    const cardWidth = (WIDTH - gap * 2) / 3
    const cardHeight = 96
    const cardTop = y
    const cards = [0, 1, 2].map(index => MARGIN + index * (cardWidth + gap))
    const inner = cardWidth - 28
    for (const x of cards) box(x, cardTop - cardHeight, cardWidth, cardHeight, PANEL, 9, RULE)

    {
        const x = cards[0] + 14
        let at = cardTop - 22
        label('Billed to', x, at)
        at -= 19
        text(fit(fonts.bold, 11, invoice.billToName, inner), x, at, { size: 11, bold: true })
        at -= 15
        if (invoice.billToCompany) {
            text(fit(fonts.regular, 9, invoice.billToCompany, inner), x, at, { size: 9, color: INK_2 })
            at -= 13
        }
        text(fit(fonts.regular, 9, invoice.billToEmail, inner), x, at, { size: 9, color: INK_2 })
    }

    {
        const x = cards[1] + 14
        const right = cards[1] + cardWidth - 14
        let at = cardTop - 22
        label('Dates', x, at)
        at -= 19
        const rows: [string, string][] = [
            ['Issued', invoice.issuedOn ? formatDayShort(invoice.issuedOn) : 'Not yet sent'],
            ['Due', formatDayShort(invoice.dueOn)],
        ]
        if (invoice.periodStart && invoice.periodEnd) {
            // The year once, at the end, when both ends share it: "1 Oct to 31 Oct 2026"
            const sameYear = invoice.periodStart.slice(0, 4) === invoice.periodEnd.slice(0, 4)
            const from = formatDayShort(invoice.periodStart)
            rows.push(['Period', `${sameYear ? from.replace(/\s*\d{4}$/, '') : from} to ${formatDayShort(invoice.periodEnd)}`])
        }
        for (const [name, value] of rows) {
            text(name, x, at, { size: 9, color: INK_3 })
            text(fit(fonts.bold, 9, value, inner - 40), right, at, { size: 9, bold: true, align: 'right' })
            at -= 15
        }
    }

    const balance = Math.max(0, invoice.totalCents - invoice.paidCents)
    {
        const x = cards[2] + 14
        const right = cards[2] + cardWidth - 14
        const settled = invoice.standing === 'paid' || invoice.standing === 'void'
        box(cards[2], cardTop - cardHeight, cardWidth, cardHeight, settled ? PANEL : LAKE_TINT, 9, settled ? RULE : mix('#8fd4f5', NIGHT, 0.3))
        let at = cardTop - 22
        label(settled ? 'Total' : 'Amount due', x, at, { color: settled ? INK_3 : LAKE })
        at -= 30
        const amount = formatMoney(settled ? invoice.totalCents : balance, invoice.currency)
        text(fit(fonts.bold, 22, amount, inner), x, at, { size: 22, bold: true, color: settled ? INK : LAKE })
        at -= 14
        label(invoice.currency, x, at, { color: INK_3 })
        pill(invoice.standing, right, cardTop - cardHeight + 26)
    }

    y = cardTop - cardHeight - 26

    // The lines
    const tableHead = () => {
        box(MARGIN, y - 24, WIDTH, 24, PANEL_HI, 6)
        const at = y - 15
        label('Description', COLUMNS.description, at)
        label('Qty', COLUMNS.quantity, at, { align: 'right' })
        label('Unit price', COLUMNS.unit, at, { align: 'right' })
        label('Amount', COLUMNS.amount, at, { align: 'right' })
        y -= 24 + 18
    }
    tableHead()

    invoice.lines.forEach((line, index) => {
        const wrapped = wrap(fonts.regular, 10, line.description, DESCRIPTION_WIDTH)
        const height = wrapped.length * 14 + 12
        if (y - height < BOTTOM + 20) {
            continued()
            tableHead()
        }
        if (index > 0) rule(y + 14, MARGIN + 14, RIGHT - 14)
        text(formatQuantity(line.quantity), COLUMNS.quantity, y, { color: INK_2, align: 'right' })
        text(formatMoney(line.unitCents, invoice.currency), COLUMNS.unit, y, { color: INK_2, align: 'right' })
        text(formatMoney(line.amountCents, invoice.currency), COLUMNS.amount, y, { bold: true, align: 'right' })
        for (const part of wrapped) {
            text(part, COLUMNS.description, y)
            y -= 14
        }
        y -= 12
    })

    // The totals, in a box under the amounts
    const totals: { label: string, value: string }[] = [{ label: 'Subtotal', value: formatMoney(invoice.subtotalCents, invoice.currency) }]
    if (invoice.gst) totals.push({ label: `GST (${GST_RATE * 100}%)`, value: formatMoney(invoice.gstCents, invoice.currency) })
    totals.push({ label: `Total (${invoice.currency})`, value: formatMoney(invoice.totalCents, invoice.currency) })
    if (invoice.paidCents > 0) {
        totals.push({ label: invoice.paidOn ? `Paid ${formatDayShort(invoice.paidOn)}` : 'Paid', value: `-${formatMoney(invoice.paidCents, invoice.currency)}` })
    }
    const showBalance = invoice.standing !== 'void'
    const totalsHeight = totals.length * 18 + 14 + (showBalance ? 40 : 0) + (invoice.gst ? 0 : 16)
    if (y - totalsHeight < BOTTOM + 10) continued()

    const totalsLeft = 322
    const totalsWidth = RIGHT - totalsLeft
    y -= 2
    box(totalsLeft, y - totalsHeight + (invoice.gst ? 0 : 16), totalsWidth, totalsHeight - (invoice.gst ? 0 : 16), PANEL, 9, RULE)
    y -= 22
    for (const row of totals) {
        text(row.label, totalsLeft + 14, y, { size: 9.5, color: INK_2 })
        text(row.value, RIGHT - 14, y, { size: 9.5, align: 'right' })
        y -= 18
    }
    if (showBalance) {
        const paid = balance === 0
        const tone = paid ? TONES.paid : invoice.standing === 'overdue' ? TONES.overdue : TONES.due
        box(totalsLeft + 6, y - 22, totalsWidth - 12, 32, tone.fill, 7)
        text(paid ? 'Paid in full' : 'Balance due', totalsLeft + 14, y - 10, { size: 10.5, bold: true, color: tone.ink })
        text(formatMoney(balance, invoice.currency), RIGHT - 14, y - 11, { size: 14, bold: true, color: tone.ink, align: 'right' })
        y -= 40
    } else {
        y += 4
    }
    if (!invoice.gst) {
        text('No GST has been charged.', RIGHT - 4, y - 8, { size: 8, color: INK_3, align: 'right' })
        y -= 16
    }

    // Notes and how to pay, each a box with a stripe of colour down its edge
    const block = (heading: string, body: string, accent: RGB, link?: string) => {
        const lines = wrap(fonts.regular, 9.5, body, WIDTH - 36)
        const height = 38 + lines.length * 13.5 + (link ? 16 : 0)
        if (y - 18 - height < BOTTOM) continued()
        y -= 18
        box(MARGIN, y - height, WIDTH, height, PANEL, 9, RULE)
        page.drawRectangle({ x: MARGIN, y: y - height + 9, width: 3, height: height - 18, color: accent })
        let at = y - 21
        label(heading, MARGIN + 20, at, { color: accent })
        at -= 17
        for (const line of lines) {
            text(line, MARGIN + 20, at, { size: 9.5, color: INK_2 })
            at -= 13.5
        }
        if (link) text(link, MARGIN + 20, at - 2, { size: 9.5, bold: true, color: LAKE })
        y -= height
    }

    if (invoice.notes) block('Notes', invoice.notes, INK_3)
    if (invoice.standing === 'due' || invoice.standing === 'overdue') {
        block('How to pay', `Pay online with PayPal or a card by ${formatDay(invoice.dueOn)}. For any other kind of payment, please quote ${number}.`, LAKE, options.payUrl)
    }

    if (y - 34 > BOTTOM) text('Thank you for your business.', MARGIN, y - 34, { size: 9.5, color: INK_2 })

    // A footer on every page, numbered now that the count is known
    const pages = pdf.getPages()
    pages.forEach((each, index) => {
        page = each
        rule(BOTTOM - 22)
        text(`${business.name}  ·  ABN ${business.abn}  ·  ${business.email}`, MARGIN, BOTTOM - 38, { size: 8, color: INK_3 })
        text(`${number}  ·  Page ${index + 1} of ${pages.length}`, RIGHT, BOTTOM - 38, { size: 8, color: INK_3, align: 'right' })
    })

    return Buffer.from(await pdf.save())
}
