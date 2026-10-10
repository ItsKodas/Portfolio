'use client'

// The public contact a client's sites show a visitor while they are down, as both the client's account page
// and the operator's client page draw it. The two differ only in who saves it and in the box that lists it,
// which only the operator gets: a client fills the details in, the operator decides whether they are shown.

import { useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Field } from '@/ui/Field/Field'
import styles from './form.module.css'

export type PublicContactInput = { name: string | null, email: string | null, phone: string | null }
type Result = { ok: true } | { ok: false, error: string }

export function PublicContactForm({ intro, initial, listed, save }: {
    intro: string
    initial: PublicContactInput
    // Present on the operator's page, where it is a box to tick; on the client's page it is only said
    listed: { value: boolean, editable: boolean }
    save: (input: PublicContactInput, listed: boolean) => Promise<Result>
}) {
    const [name, setName] = useState(initial.name ?? '')
    const [email, setEmail] = useState(initial.email ?? '')
    const [phone, setPhone] = useState(initial.phone ?? '')
    const [isListed, setListed] = useState(listed.value)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [done, setDone] = useState(false)

    async function submit(event: React.FormEvent) {
        event.preventDefault()
        setPending(true)
        setError(null)
        setDone(false)
        try {
            const result = await save({ name: name || null, email: email || null, phone: phone || null }, isListed)
            if (result.ok) setDone(true)
            else setError(result.error)
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }

    return (
        <form onSubmit={submit}>
            <p className={styles.intro}>{intro}</p>
            <div className={styles.fields}>
                <Field label="Business name" value={name} onChange={event => { setName(event.target.value); setDone(false) }} />
                <Field label="Business email" type="email" value={email} onChange={event => { setEmail(event.target.value); setDone(false) }} />
                <Field label="Business phone" type="tel" value={phone} onChange={event => { setPhone(event.target.value); setDone(false) }} />
            </div>
            {listed.editable ? (
                <label className={styles.listed}>
                    <input type="checkbox" checked={isListed} onChange={event => { setListed(event.target.checked); setDone(false) }} />
                    Show these on their sites&apos; holding page
                </label>
            ) : (
                <p className={styles.note}>
                    {listed.value
                        ? 'These are shown on your sites’ holding page.'
                        : 'These are not shown yet. Koda switches them on once they are filled in.'}
                </p>
            )}
            <Button type="submit" variant="primary" disabled={pending}>Save</Button>
            {error && <div className={styles.message}><Callout tone="crit" title={error}>{null}</Callout></div>}
            {done && <div className={styles.message}><Callout tone="good" title="Saved.">{null}</Callout></div>}
        </form>
    )
}
