// The one shell every transactional email is poured into. Both versions come out of the same blocks, so the
// plain text and the HTML can never drift apart the way two hand-written copies would.
//
// Written the way email has to be written rather than the way the site is: tables instead of divs, styles
// inline instead of in a stylesheet, and a bgcolor attribute beside every background colour, because Outlook
// reads the attribute and ignores the CSS.

import 'server-only'

import { TOKENS } from '../../ui/tokens'

export type Email = { from: string, to: string, replyTo: string, subject: string, text: string, html: string }

export const escapeHtml = (text: string) => text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export type Fact = { lead: string, rest: string }

export type Block =
    | { kind: 'paragraph', text: string }
    | { kind: 'button', label: string, url: string }
    | { kind: 'facts', items: Fact[] }
    | { kind: 'callout', lead: string, rest: string }
    | { kind: 'fields', rows: [string, string][] }
    | { kind: 'message', text: string }

export const paragraph = (text: string): Block => ({ kind: 'paragraph', text })

// The only block that can produce a link. Everything else is text, which is what lets the security notices
// promise they contain no link at all: they simply have no button.
export const button = (label: string, url: string): Block => ({ kind: 'button', label, url })

// What to expect, under a rule, once the main point has been made
export const facts = (items: Fact[]): Block => ({ kind: 'facts', items })

// The one thing to do if something is wrong, on its own panel so it survives a skim
export const callout = (lead: string, rest: string): Block => ({ kind: 'callout', lead, rest })

// Label and value pairs, already filtered by the caller: a row that reaches here is a row worth showing
export const fields = (rows: [string, string][]): Block => ({ kind: 'fields', rows })

// Something a stranger typed, kept as they typed it and never trusted as markup
export const message = (text: string): Block => ({ kind: 'message', text })

export type Content = {
    // Never shown in the body. It is the line the inbox puts after the subject, which otherwise reads "Hi Ann,".
    preheader: string
    eyebrow: string
    heading: string
    // A summary worth reading before the detail, such as what a quote is actually asking for
    subheading?: string
    footer: string
    siteUrl: string
    // lake is the site's one interactive accent; blush means a person did this, and nothing else
    tone?: 'notice'
    blocks: Block[]
}

export type Rendered = { text: string, html: string }

const font = `-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`

// One place for the type, so a paragraph in one email can't quietly be a different size from a paragraph in
// the next
const type = {
    eyebrow: `font-family:${font};font-size:11px;letter-spacing:1.6px;font-weight:700;text-transform:uppercase`,
    heading: `font-family:${font};font-size:26px;line-height:34px;font-weight:700;color:${TOKENS.ink}`,
    body: `font-family:${font};font-size:15px;line-height:24px;color:${TOKENS['ink-2']}`,
    sub: `font-family:${font};font-size:14px;line-height:22px;color:${TOKENS['ink-3']}`,
    small: `font-family:${font};font-size:12px;line-height:19px;color:${TOKENS['ink-3']}`,
}

const cell = (style: string, content: string) => `<tr><td style="${style}">${content}</td></tr>`

function buttonHtml(label: string, url: string, accent: string): string {
    const href = escapeHtml(url)
    const padded = `padding:14px 26px;font-family:${font};font-size:15px;font-weight:700;color:${TOKENS.night};text-decoration:none`
    // A table rather than a styled anchor, because Outlook drops the padding on an inline-block
    const control = `<tr><td style="padding:26px 36px 0">`
        + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
        + `<td bgcolor="${accent}" style="background-color:${accent};border-radius:${TOKENS['radius-control']}">`
        + `<a href="${href}" style="display:inline-block;${padded};border-radius:${TOKENS['radius-control']}">${escapeHtml(label)}</a>`
        + `</td></tr></table></td></tr>`
    // The anchor text is the address itself, so the href and what the reader sees are the same string
    const fallback = cell(`padding:18px 36px 0;${type.small}`,
        `Button not working? Copy this address into your browser:<br>`
        + `<a href="${href}" style="color:${TOKENS['ink-3']};text-decoration:underline;word-break:break-all">${href}</a>`)
    return control + fallback
}

const rule = `<tr><td style="padding:28px 36px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`
    + `<tr><td bgcolor="${TOKENS.rule}" height="1" style="background-color:${TOKENS.rule};height:1px;line-height:1px;font-size:1px">&nbsp;</td></tr>`
    + `</table></td></tr>`

function factsHtml(items: Fact[], accent: string): string {
    const dot = `<td width="8" valign="top" style="width:8px;padding-top:8px">`
        + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
        + `<td bgcolor="${accent}" width="5" height="5" style="background-color:${accent};width:5px;height:5px;line-height:5px;font-size:5px;border-radius:3px">&nbsp;</td>`
        + `</tr></table></td>`
    const rows = items.map((item, index) => {
        const gap = index === 0 ? '' : `<tr><td colspan="2" height="12" style="height:12px;line-height:12px;font-size:12px">&nbsp;</td></tr>`
        return gap + `<tr>${dot}<td style="padding-left:12px;font-family:${font};font-size:14px;line-height:22px;color:${TOKENS['ink-2']}">`
            + `<span style="color:${TOKENS.ink};font-weight:600">${escapeHtml(item.lead)}</span> ${escapeHtml(item.rest)}</td></tr>`
    })
    return rule + `<tr><td style="padding:22px 36px 0">`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>`
        + `</td></tr>`
}

function calloutHtml(lead: string, rest: string): string {
    return `<tr><td style="padding:24px 36px 0">`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS['panel-hi']}" style="background-color:${TOKENS['panel-hi']};border-radius:${TOKENS['radius-control']}">`
        + `<tr><td style="padding:14px 18px;font-family:${font};font-size:14px;line-height:22px;color:${TOKENS.ink}">`
        + `<span style="font-weight:700">${escapeHtml(lead)}</span> <span style="color:${TOKENS['ink-2']}">${escapeHtml(rest)}</span>`
        + `</td></tr></table></td></tr>`
}

function fieldsHtml(rows: [string, string][]): string {
    const divider = `<tr><td colspan="2" bgcolor="${TOKENS.rule}" height="1" style="background-color:${TOKENS.rule};height:1px;line-height:1px;font-size:1px">&nbsp;</td></tr>`
    const body = rows.map(([label, value], index) =>
        (index === 0 ? '' : divider)
        + `<tr><td width="130" valign="top" style="width:130px;padding:7px 0;color:${TOKENS['ink-3']}">${escapeHtml(label)}</td>`
        + `<td valign="top" style="padding:7px 0;color:${TOKENS.ink}">${escapeHtml(value).replace(/\n/g, '<br>')}</td></tr>`)
    return `<tr><td style="padding:24px 36px 0">`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${font};font-size:14px;line-height:22px">${body.join('')}</table>`
        + `</td></tr>`
}

function messageHtml(text: string): string {
    return `<tr><td style="padding:22px 36px 0">`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.deep}" style="background-color:${TOKENS.deep};border:1px solid ${TOKENS.rule};border-radius:${TOKENS['radius-control']}">`
        + `<tr><td style="padding:16px 18px;font-family:${font};font-size:14px;line-height:23px;color:${TOKENS['ink-2']}">${escapeHtml(text).replace(/\n/g, '<br>')}</td></tr>`
        + `</table></td></tr>`
}

function blockHtml(block: Block, accent: string): string {
    switch (block.kind) {
        case 'paragraph':
            return cell(`padding:14px 36px 0;${type.body}`, escapeHtml(block.text))
        case 'button':
            return buttonHtml(block.label, block.url, accent)
        case 'facts':
            return factsHtml(block.items, accent)
        case 'callout':
            return calloutHtml(block.lead, block.rest)
        case 'fields':
            return fieldsHtml(block.rows)
        case 'message':
            return messageHtml(block.text)
    }
}

function blockText(block: Block): string {
    switch (block.kind) {
        case 'paragraph':
            return block.text
        case 'button':
            return `${block.label}:\n${block.url}`
        case 'facts':
            return block.items.map(item => `${item.lead} ${item.rest}`).join('\n\n')
        case 'callout':
            return `${block.lead} ${block.rest}`
        case 'fields':
            // A value of several lines is indented under its label, so the label column stays readable
            return block.rows.map(([label, value]) => `${label}: ${value.replace(/\n/g, '\n    ')}`).join('\n')
        case 'message':
            return block.text
    }
}

export function render(content: Content): Rendered {
    const accent = content.tone === 'notice' ? TOKENS.blush : TOKENS.lake
    const logo = `${content.siteUrl}/images/logo.png`

    // The wordmark is live text rather than part of the image: a client that blocks images still shows it
    const header = `<tr><td style="padding:0 4px 20px">`
        + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
        + `<td width="34" style="width:34px"><img src="${escapeHtml(logo)}" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border:0"></td>`
        + `<td style="padding-left:12px;font-family:${font};font-size:15px;line-height:34px;letter-spacing:2.5px;font-weight:700;color:${TOKENS.ink}">HORIZONS</td>`
        + `</tr></table></td></tr>`

    const card = `<tr><td bgcolor="${TOKENS.panel}" style="background-color:${TOKENS.panel};border:1px solid ${TOKENS.rule};border-radius:${TOKENS['radius-card']}">`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`
        + `<tr><td bgcolor="${accent}" height="3" style="background-color:${accent};height:3px;line-height:3px;font-size:3px">&nbsp;</td></tr>`
        + cell(`padding:34px 36px 8px;${type.eyebrow};color:${accent}`, escapeHtml(content.eyebrow))
        + cell(`padding:0 36px 6px;${type.heading}`, escapeHtml(content.heading))
        + (content.subheading ? cell(`padding:2px 36px 0;${type.sub}`, escapeHtml(content.subheading)) : '')
        + content.blocks.map(block => blockHtml(block, accent)).join('')
        + `<tr><td height="34" style="height:34px;line-height:34px;font-size:34px">&nbsp;</td></tr>`
        + `</table></td></tr>`

    const footer = cell(`padding:22px 20px 0;${type.small}`, escapeHtml(content.footer))

    const html = `<!doctype html><html lang="en"><head>`
        + `<meta charset="utf-8">`
        + `<meta name="viewport" content="width=device-width,initial-scale=1">`
        // Without these two, Gmail and Apple Mail try to "helpfully" re-theme an email that is already dark
        + `<meta name="color-scheme" content="dark">`
        + `<meta name="supported-color-schemes" content="dark">`
        + `<title>${escapeHtml(content.heading)}</title>`
        + `</head><body style="margin:0;padding:0;background-color:${TOKENS.night}">`
        + `<div style="display:none;font-size:1px;color:${TOKENS.night};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${escapeHtml(content.preheader)}</div>`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TOKENS.night}" style="background-color:${TOKENS.night};margin:0;padding:0">`
        + `<tr><td align="center" style="padding:32px 16px">`
        // Outlook ignores max-width, so it gets a fixed 600 wrapper of its own; every other client uses the
        // percentage table inside, which is what lets this fold down on a phone
        + `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto">`
        + header + card + footer
        + `</table>`
        + `<!--[if mso]></td></tr></table><![endif]-->`
        + `</td></tr></table></body></html>`

    const sub = content.subheading ? [content.subheading] : []
    const text = [content.heading, ...sub, ...content.blocks.map(blockText), content.footer].join('\n\n')
    return { text, html }
}
