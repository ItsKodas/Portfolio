'use client'

// The Tax page's forms: adding an expense or income, deleting one, and a year's own details. Each calls a server
// action and shows its error, if any; a successful action refreshes the page (the actions revalidate it).

import { useState } from 'react'

import { dollarsText } from '@/server/invoices/money'
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '@/server/tax/schema'
import type { YearSettings } from '@/server/tax/summary'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { DeleteOutline } from '@/ui/icons'
import { addBalanceItemAction, addEntryAction, deleteBalanceItemAction, deleteEntryAction, saveYearAction, type TaxResult } from './actions'
import styles from './tax.module.css'

function useAction() {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    async function run(action: () => Promise<TaxResult>, onDone?: () => void) {
        setPending(true)
        setError(null)
        try {
            const result = await action()
            if (result.ok) onDone?.()
            else setError(result.error)
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }
    return { pending, error, run }
}

const Problem = ({ error }: { error: string | null }) => (
    error ? <div className={styles.problem}><Callout tone="crit" title={error}>{null}</Callout></div> : null
)

// A new entry defaults to today, unless the year on show has closed, when its last day is the likelier date
export function EntryForm({ kind, defaultDay, min, max }: { kind: 'EXPENSE' | 'INCOME', defaultDay: string, min: string, max: string }) {
    const { pending, error, run } = useAction()
    const categories: readonly string[] = kind === 'EXPENSE' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES
    const blank = { occurredOn: defaultDay, description: '', category: categories[0], amount: '', businessPercent: '100' }
    const [form, setForm] = useState(blank)
    const set = (patch: Partial<typeof form>) => setForm(current => ({ ...current, ...patch }))

    function submit() {
        run(() => addEntryAction({
            kind, occurredOn: form.occurredOn, description: form.description, category: form.category,
            amountCents: form.amount, ...(kind === 'EXPENSE' && { businessPercent: form.businessPercent }),
        }), () => setForm({ ...blank, occurredOn: form.occurredOn, category: form.category }))
    }

    return (
        <form className={styles.form} onSubmit={event => { event.preventDefault(); submit() }}>
            <Field label="What for" value={form.description} onChange={event => set({ description: event.target.value })}
                placeholder={kind === 'EXPENSE' ? 'Figma, a year' : 'Logo job, paid in cash'} required maxLength={200} />
            <Field as="select" label="Category" value={form.category} onChange={event => set({ category: event.target.value })}>
                {categories.map(category => <option key={category} value={category}>{category}</option>)}
            </Field>
            <div className={styles.formPair}>
                <Field label="Amount ($)" inputMode="decimal" placeholder="0.00" value={form.amount} onChange={event => set({ amount: event.target.value })} required />
                <Field label="Date" type="date" value={form.occurredOn} min={min} max={max} onChange={event => set({ occurredOn: event.target.value })} required />
            </div>
            {kind === 'EXPENSE' && (
                <div className={styles.formPair}>
                    <Field label="Business use (%)" inputMode="numeric" value={form.businessPercent}
                        onChange={event => set({ businessPercent: event.target.value })} required />
                    <p className={styles.small}>Less than 100 for something you also use privately, like a phone.</p>
                </div>
            )}
            <div>
                <Button type="submit" variant="primary" size="small" disabled={pending}>{kind === 'EXPENSE' ? 'Add expense' : 'Add income'}</Button>
            </div>
            <Problem error={error} />
        </form>
    )
}

export function DeleteEntry({ id, description, line = false }: { id: string, description: string, line?: boolean }) {
    const { pending, error, run } = useAction()
    const [open, setOpen] = useState(false)
    return (
        <>
            <Button variant="quiet" size="small" aria-label={`Delete ${description}`} disabled={pending} onClick={() => setOpen(true)}>
                <DeleteOutline size={14} />
            </Button>
            <Dialog
                open={open}
                onClose={() => setOpen(false)}
                title={line ? 'Delete this line?' : 'Delete this entry?'}
                footer={
                    <>
                        <Button onClick={() => setOpen(false)}>Cancel</Button>
                        <Button variant="danger" disabled={pending} onClick={() => run(() => (line ? deleteBalanceItemAction(id) : deleteEntryAction(id)), () => setOpen(false))}>Delete</Button>
                    </>
                }
            >
                <p className={styles.dialogText}>&ldquo;{description}&rdquo; comes off this year&rsquo;s {line ? 'balance sheet' : 'figures'}.</p>
                <Problem error={error} />
            </Dialog>
        </>
    )
}

const amountText = (cents: number) => (cents ? dollarsText(cents) : '')

export function YearForm({ year, settings, returnOpen }: { year: number, settings: YearSettings, returnOpen: boolean }) {
    const { pending, error, run } = useAction()
    const [saved, setSaved] = useState(false)
    const [form, setForm] = useState({
        otherIncome: amountText(settings.otherIncomeCents),
        withheld: amountText(settings.withheldCents),
        lodgedOn: settings.lodgedOn ?? '',
    })
    const set = (patch: Partial<typeof form>) => { setSaved(false); setForm(current => ({ ...current, ...patch })) }

    return (
        <form className={styles.form} onSubmit={event => {
            event.preventDefault()
            run(() => saveYearAction({ year, otherIncomeCents: form.otherIncome, withheldCents: form.withheld, lodgedOn: form.lodgedOn }), () => setSaved(true))
        }}>
            <Field label="Other income this year ($)" hint="Wages or anything else on your return. It changes the rate the business is taxed at."
                inputMode="decimal" placeholder="0.00" value={form.otherIncome} onChange={event => set({ otherIncome: event.target.value })} />
            <Field label="Tax already paid ($)" hint="Withheld from that income, or paid to the ATO as instalments."
                inputMode="decimal" placeholder="0.00" value={form.withheld} onChange={event => set({ withheld: event.target.value })} />
            <Field label="Return lodged on" type="date" hint={returnOpen ? 'Set it once the return is in, and the reminders for this year stop.' : undefined}
                value={form.lodgedOn} onChange={event => set({ lodgedOn: event.target.value })} />
            <div className={styles.formActions}>
                <Button type="submit" variant="primary" size="small" disabled={pending}>Save</Button>
                {saved && <span className={styles.saved}>Saved</span>}
            </div>
            <Problem error={error} />
        </form>
    )
}

// A line of the balance sheet the portal can't work out: the bank balance, equipment, a credit card
export function BalanceForm({ year }: { year: number }) {
    const { pending, error, run } = useAction()
    const blank = { side: 'ASSET', name: '', amount: '' }
    const [form, setForm] = useState(blank)
    const set = (patch: Partial<typeof form>) => setForm(current => ({ ...current, ...patch }))
    return (
        <form className={styles.form} onSubmit={event => {
            event.preventDefault()
            run(() => addBalanceItemAction({ year, side: form.side, name: form.name, amountCents: form.amount }), () => setForm({ ...blank, side: form.side }))
        }}>
            <Field label="Name" value={form.name} onChange={event => set({ name: event.target.value })}
                placeholder={form.side === 'ASSET' ? 'Business bank account' : 'Credit card'} required maxLength={120} />
            <div className={styles.formPair}>
                <Field as="select" label="It is" value={form.side} onChange={event => set({ side: event.target.value })}>
                    <option value="ASSET">Owned (asset)</option>
                    <option value="LIABILITY">Owed (liability)</option>
                </Field>
                <Field label="Amount ($)" inputMode="decimal" placeholder="0.00" value={form.amount} onChange={event => set({ amount: event.target.value })} required />
            </div>
            <div>
                <Button type="submit" variant="primary" size="small" disabled={pending}>Add line</Button>
            </div>
            <Problem error={error} />
        </form>
    )
}
