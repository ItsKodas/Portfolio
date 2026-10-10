// Where an invoice stands, in the words both sides of the portal use. Stored status says DRAFT, OPEN, PAID or
// VOID; due and overdue are worked out from the due date when asked, so an invoice never needs a job to go
// round marking it late.

import { type Day } from './days'

export type InvoiceStatus = 'DRAFT' | 'OPEN' | 'PAID' | 'VOID'
export type Standing = 'draft' | 'due' | 'overdue' | 'paid' | 'void'

export const STANDINGS: Standing[] = ['draft', 'due', 'overdue', 'paid', 'void']

export const STANDING_LABELS: Record<Standing, string> = {
    draft: 'Draft',
    due: 'Due',
    overdue: 'Overdue',
    paid: 'Paid',
    void: 'Void',
}

// ui/Chip's tones. Due is neutral: an invoice waiting to be paid is nothing wrong yet.
export const STANDING_TONES: Record<Standing, 'good' | 'warn' | 'crit' | undefined> = {
    draft: undefined,
    due: undefined,
    overdue: 'crit',
    paid: 'good',
    void: 'warn',
}

export const isStanding = (value: unknown): value is Standing =>
    typeof value === 'string' && (STANDINGS as string[]).includes(value)

// Overdue the day after it is due, not on it: "due on the 14th" means the 14th is still in time
export function standingOf(invoice: { status: InvoiceStatus, dueOn: Day }, today: Day): Standing {
    switch (invoice.status) {
        case 'DRAFT': return 'draft'
        case 'PAID': return 'paid'
        case 'VOID': return 'void'
        case 'OPEN': return invoice.dueOn < today ? 'overdue' : 'due'
    }
}

// INV-0042. Padded to four so a list sorts the way it reads until the ten-thousandth invoice.
export const invoiceNumber = (number: number | null): string =>
    number === null ? 'Draft' : `INV-${String(number).padStart(4, '0')}`
