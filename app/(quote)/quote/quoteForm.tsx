'use client'

// The quote form: checks itself as it's sent for instant feedback, then the server checks again (see
// server/quotes/submit.ts). On success it's replaced by a thank-you in place.

import { useState } from 'react'
import { Add, Close } from '@mui/icons-material'

import { BUDGETS, BUDGET_LABELS, PROJECT_TYPES, PROJECT_TYPE_LABELS, TIMELINES, TIMELINE_LABELS } from '@/server/quotes/labels'
import { MAX_REFERENCE_SITES, firstErrors, quoteSchema, type FieldErrors, type QuoteField } from '@/server/quotes/schema'
import { submitQuoteAction } from './actions'
import Turnstile from './turnstile'

type TextField = Exclude<QuoteField, 'referenceSites'>
type Values = Record<TextField, string> & { referenceSites: string[] }

const EMPTY: Values = {
    name: '', email: '', company: '', website: '', projectType: '', budget: '', timeline: '', message: '', referenceSites: [''],
}

const FAILURES = {
    turnstile: "The spam check didn't go through. Please try again.",
    'rate-limited': "You've sent a few requests already. Please try again in an hour or so.",
    server: 'Something went wrong on my end. Please try again in a moment.',
    invalid: 'A few details need another look.',
}

const panel = 'rounded-3xl border border-[#8fd4f5]/10 bg-[#111a38]/55 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_60px_-30px_rgba(0,0,0,0.6)]'
const input = 'w-full rounded-2xl border border-[#8fd4f5]/15 bg-[#0b101f]/70 px-4 py-3 text-sm text-white placeholder:text-[#8fa3c7]/50 transition-colors focus:border-[#8fd4f5]/50 focus:outline-none'
const label = 'mb-2 block text-sm font-medium text-[#dbe6f7]'

function Field({ id, title, optional, error, children }: { id: string, title: string, optional?: boolean, error?: string, children: React.ReactNode }) {
    return (
        <div>
            <label htmlFor={id} className={label}>
                {title}
                {optional && <span className="ml-2 text-xs font-normal text-[#8fa3c7]">optional</span>}
            </label>
            {children}
            {error && <p id={`${id}-error`} className="mt-2 text-sm text-[#f19bb3]">{error}</p>}
        </div>
    )
}

export default function QuoteForm({ siteKey }: { siteKey: string }) {
    const [values, setValues] = useState<Values>(EMPTY)
    const [trap, setTrap] = useState('')
    const [errors, setErrors] = useState<FieldErrors>({})
    const [failure, setFailure] = useState<string | null>(null)
    const [token, setToken] = useState<string | null>(null)
    const [resetCount, setResetCount] = useState(0)
    const [sending, setSending] = useState(false)
    const [sent, setSent] = useState(false)

    const set = (field: TextField) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
        setValues(current => ({ ...current, [field]: event.target.value }))

    const setSite = (index: number, site: string) =>
        setValues(current => ({ ...current, referenceSites: current.referenceSites.map((s, i) => (i === index ? site : s)) }))

    const describedBy = (field: QuoteField) => (errors[field] ? `${field}-error` : undefined)

    async function onSubmit(event: React.FormEvent) {
        event.preventDefault()
        setFailure(null)
        const checked = quoteSchema.safeParse(values)
        if (!checked.success) {
            setErrors(firstErrors(checked.error))
            return
        }
        setErrors({})
        if (!token) {
            setFailure('Please wait a moment for the spam check to finish.')
            return
        }

        setSending(true)
        try {
            const result = await submitQuoteAction({ ...values, turnstileToken: token, fax: trap })
            if (result.ok) {
                setSent(true)
                return
            }
            if (result.reason === 'invalid') setErrors(result.fieldErrors)
            setFailure(FAILURES[result.reason])
        } catch {
            setFailure(FAILURES.server)
        } finally {
            setSending(false)
            // Each token is good for one check, so the next attempt needs a fresh one
            setToken(null)
            setResetCount(count => count + 1)
        }
    }

    if (sent) {
        return (
            <div className={`${panel} p-8 text-center`} role="status">
                <h2 className="mb-3 text-2xl font-bold text-white">Thanks, it&apos;s on its way</h2>
                <p className="text-[#b4c3dc]/80">
                    I&apos;ve got your request, and a confirmation is heading to your inbox. I&apos;ll be in touch soon.
                </p>
            </div>
        )
    }

    return (
        <form onSubmit={onSubmit} noValidate className={`${panel} space-y-6 p-6 sm:p-8`}>
            <div className="grid gap-6 sm:grid-cols-2">
                <Field id="name" title="Name" error={errors.name}>
                    <input id="name" className={input} value={values.name} onChange={set('name')} autoComplete="name" aria-invalid={!!errors.name} aria-describedby={describedBy('name')} />
                </Field>
                <Field id="email" title="Email" error={errors.email}>
                    <input id="email" type="email" className={input} value={values.email} onChange={set('email')} autoComplete="email" aria-invalid={!!errors.email} aria-describedby={describedBy('email')} />
                </Field>
                <Field id="company" title="Company" optional error={errors.company}>
                    <input id="company" className={input} value={values.company} onChange={set('company')} autoComplete="organization" aria-invalid={!!errors.company} aria-describedby={describedBy('company')} />
                </Field>
                <Field id="website" title="Current website" optional error={errors.website}>
                    <input id="website" type="url" className={input} value={values.website} onChange={set('website')} placeholder="https://" aria-invalid={!!errors.website} aria-describedby={describedBy('website')} />
                </Field>
            </div>

            <div className="grid gap-6 sm:grid-cols-3">
                <Field id="projectType" title="Project type" optional error={errors.projectType}>
                    <select id="projectType" className={input} value={values.projectType} onChange={set('projectType')}>
                        <option value="">Choose one</option>
                        {PROJECT_TYPES.map(value => <option key={value} value={value}>{PROJECT_TYPE_LABELS[value]}</option>)}
                    </select>
                </Field>
                <Field id="budget" title="Budget (AUD)" optional error={errors.budget}>
                    <select id="budget" className={input} value={values.budget} onChange={set('budget')}>
                        <option value="">Choose one</option>
                        {BUDGETS.map(value => <option key={value} value={value}>{BUDGET_LABELS[value]}</option>)}
                    </select>
                </Field>
                <Field id="timeline" title="Timeline" optional error={errors.timeline}>
                    <select id="timeline" className={input} value={values.timeline} onChange={set('timeline')}>
                        <option value="">Choose one</option>
                        {TIMELINES.map(value => <option key={value} value={value}>{TIMELINE_LABELS[value]}</option>)}
                    </select>
                </Field>
            </div>

            <Field id="message" title="Tell me about your project" error={errors.message}>
                <textarea id="message" rows={6} className={input} value={values.message} onChange={set('message')} aria-invalid={!!errors.message} aria-describedby={describedBy('message')} />
            </Field>

            <div>
                <p className={label}>
                    Sites you like the look of
                    <span className="ml-2 text-xs font-normal text-[#8fa3c7]">optional, up to {MAX_REFERENCE_SITES}</span>
                </p>
                <div className="space-y-3">
                    {values.referenceSites.map((site, index) => (
                        <div key={index} className="flex gap-2">
                            <input type="url" aria-label={`Example site ${index + 1}`} className={input} value={site} placeholder="https://" onChange={event => setSite(index, event.target.value)} />
                            {values.referenceSites.length > 1 && (
                                <button type="button" aria-label={`Remove example site ${index + 1}`} onClick={() => setValues(current => ({ ...current, referenceSites: current.referenceSites.filter((_, i) => i !== index) }))}
                                    className="shrink-0 rounded-2xl border border-[#8fd4f5]/15 px-3 text-[#8fa3c7] transition-colors hover:text-white">
                                    <Close sx={{ fontSize: 18 }} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
                {values.referenceSites.length < MAX_REFERENCE_SITES && (
                    <button type="button" onClick={() => setValues(current => ({ ...current, referenceSites: [...current.referenceSites, ''] }))}
                        className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[#8fd4f5] transition-colors hover:text-white">
                        <Add sx={{ fontSize: 18 }} /> Add another
                    </button>
                )}
                {errors.referenceSites && <p className="mt-2 text-sm text-[#f19bb3]">{errors.referenceSites}</p>}
            </div>

            {/* The honeypot: hidden from people and screen readers, so only bots fill it in */}
            <div aria-hidden="true" className="absolute left-[-10000px] top-auto h-px w-px overflow-hidden">
                <label htmlFor="fax">Fax</label>
                <input id="fax" name="fax" tabIndex={-1} autoComplete="off" value={trap} onChange={event => setTrap(event.target.value)} />
            </div>

            <Turnstile siteKey={siteKey} onToken={setToken} resetCount={resetCount} />

            {failure && <p className="text-sm text-[#f19bb3]" role="alert">{failure}</p>}

            <div className="flex flex-wrap items-center gap-4">
                <button type="submit" disabled={sending}
                    className="rounded-full border border-[#f19bb3]/40 bg-[#f19bb3]/[0.12] px-6 py-3 text-sm font-semibold text-[#f7c5d3] transition-colors hover:border-[#f19bb3]/70 hover:text-white disabled:opacity-50">
                    {sending ? 'Sending...' : 'Send request'}
                </button>
                <p className="text-xs text-[#8fa3c7]">I&apos;ll only use these details to reply to your enquiry.</p>
            </div>
        </form>
    )
}
