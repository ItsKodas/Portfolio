'use server'

// The Tax page's changes: adding and deleting an expense or a piece of income, and saving a year's details.
// Each checks the operator's session first, then does one thing, then says in the activity log what it did.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { adminActor, record } from '@/server/audit/record'
import { requireAdmin } from '@/server/auth'
import { formatMoney } from '@/server/invoices/money'
import { balanceSchema, entrySchema, yearSchema } from '@/server/tax/schema'
import { log, tax } from '@/server/tax/wiring'
import { yearLabel } from '@/server/tax/year'

export type TaxResult = { ok: true } | { ok: false, error: string }

const FAILED: TaxResult = { ok: false, error: 'That did not work. Reload the page and try again.' }

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? 'That request was not valid.'

export async function addEntryAction(input: unknown): Promise<TaxResult> {
    const actor = adminActor(await requireAdmin())
    const parsed = entrySchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
    const entry = parsed.data
    let created
    try {
        created = await tax().addEntry(entry)
    } catch (error) {
        log('Adding a tax entry failed', error)
        return FAILED
    }
    const what = entry.kind === 'EXPENSE' ? 'an expense' : 'income'
    await record({
        kind: 'tax.entryAdd', actor, target: { type: 'taxEntry', id: created.id, name: entry.description },
        summary: `Added ${what} of ${formatMoney(entry.amountCents)}: ${entry.description}`,
    })
    revalidatePath('/portal/tax')
    return { ok: true }
}

export async function deleteEntryAction(id: unknown): Promise<TaxResult> {
    const actor = adminActor(await requireAdmin())
    const parsed = z.string().min(1).max(64).safeParse(id)
    if (!parsed.success) return { ok: false, error: 'That request was not valid.' }
    let removed
    try {
        removed = await tax().deleteEntry(parsed.data)
    } catch (error) {
        log(`Deleting tax entry ${parsed.data} failed`, error)
        return FAILED
    }
    if (!removed) return { ok: false, error: 'That entry is already gone.' }
    await record({
        kind: 'tax.entryDelete', actor, target: { type: 'taxEntry', id: removed.id, name: removed.description },
        summary: `Deleted ${removed.kind === 'EXPENSE' ? 'an expense' : 'income'} of ${formatMoney(removed.amountCents)}: ${removed.description}`,
    })
    revalidatePath('/portal/tax')
    return { ok: true }
}

export async function saveYearAction(input: unknown): Promise<TaxResult> {
    const actor = adminActor(await requireAdmin())
    const parsed = yearSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
    try {
        await tax().saveYear(parsed.data)
    } catch (error) {
        log(`Saving tax year ${parsed.data.year} failed`, error)
        return FAILED
    }
    const label = yearLabel(parsed.data.year)
    await record({
        kind: 'tax.yearSave', actor, target: { type: 'taxYear', id: String(parsed.data.year), name: label },
        summary: parsed.data.lodgedOn ? `Saved the ${label} tax year, return lodged ${parsed.data.lodgedOn}` : `Saved the ${label} tax year details`,
    })
    revalidatePath('/portal/tax')
    return { ok: true }
}

export async function addBalanceItemAction(input: unknown): Promise<TaxResult> {
    const actor = adminActor(await requireAdmin())
    const parsed = balanceSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) }
    let created
    try {
        created = await tax().addBalanceItem(parsed.data)
    } catch (error) {
        log('Adding a balance sheet line failed', error)
        return FAILED
    }
    await record({
        kind: 'tax.balanceAdd', actor, target: { type: 'taxBalance', id: created.id, name: parsed.data.name },
        summary: `Added ${parsed.data.side === 'ASSET' ? 'an asset' : 'a liability'} of ${formatMoney(parsed.data.amountCents)} to the ${yearLabel(parsed.data.year)} balance sheet: ${parsed.data.name}`,
    })
    revalidatePath('/portal/tax')
    return { ok: true }
}

export async function deleteBalanceItemAction(id: unknown): Promise<TaxResult> {
    const actor = adminActor(await requireAdmin())
    const parsed = z.string().min(1).max(64).safeParse(id)
    if (!parsed.success) return { ok: false, error: 'That request was not valid.' }
    let removed
    try {
        removed = await tax().deleteBalanceItem(parsed.data)
    } catch (error) {
        log(`Deleting balance sheet line ${parsed.data} failed`, error)
        return FAILED
    }
    if (!removed) return { ok: false, error: 'That line is already gone.' }
    await record({
        kind: 'tax.balanceDelete', actor, target: { type: 'taxBalance', id: removed.id, name: removed.name },
        summary: `Deleted ${removed.name} from the ${yearLabel(removed.year)} balance sheet`,
    })
    revalidatePath('/portal/tax')
    return { ok: true }
}
