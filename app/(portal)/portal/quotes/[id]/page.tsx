import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { emailsMissing } from '@/server/quotes/emails'
import { BUDGET_LABELS, PROJECT_TYPE_LABELS, STATUS_LABELS, TIMELINE_LABELS } from '@/server/quotes/labels'
import { quoteRepo } from '@/server/quotes/repo'
import { Callout } from '@/ui/Callout/Callout'
import { Chip } from '@/ui/Chip/Chip'
import { Row } from '@/ui/Row/Row'
import { STATUS_TONES, formatWhen } from '../../format'
import AdminHeader from '../../adminHeader'
import frame from '../../frame.module.css'
import { DeleteNoteButton, NoteForm, QuoteActions, StatusPicker } from './controls'
import styles from './quote.module.css'

export const metadata: Metadata = { title: 'Quote' }

// Links the prospect typed in: only ever http or https (the schema refuses anything else), opened without telling the
// other site where the click came from
function External({ href }: { href: string }) {
    return <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={styles.external}>{href}</a>
}

function Detail({ label, children }: { label: string, children: React.ReactNode }) {
    return (
        <div>
            <p className={styles.label}>{label}</p>
            <div className={styles.value}>{children}</div>
        </div>
    )
}

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin()
    const { id } = await params
    const quote = await quoteRepo(getDb()).get(id)
    if (!quote) notFound()
    const missing = emailsMissing(quote, new Date())

    return (
        <div className={[frame.page, frame.md].join(' ')}>
            <AdminHeader />
            <div className={[frame.head, frame.headCentred, styles.titleRow].join(' ')}>
                <h1 className={frame.title}>{quote.name}</h1>
                <Chip tone={STATUS_TONES[quote.status]}>{STATUS_LABELS[quote.status]}</Chip>
                {quote.archivedAt && <Chip>Archived</Chip>}
                {quote.client
                    ? (
                        <Link href={`/admin/clients/${quote.client.id}`} className={[frame.action, frame.actionSmall].join(' ')}>
                            Client: {quote.client.company ?? quote.client.name}
                        </Link>
                    )
                    : quote.status === 'WON' && (
                        <Link href={`/admin/clients/new?fromQuote=${quote.id}`} className={[frame.action, frame.actionPrimary, frame.actionSmall].join(' ')}>
                            Create client from this quote
                        </Link>
                    )}
            </div>
            <p className={[frame.sub, frame.subBlock].join(' ')}>Received {formatWhen(quote.createdAt)}</p>

            {missing && (
                <div className={frame.subBlock}>
                    <Callout tone="warn" title="An email for this quote was not sent">
                        {!quote.notifiedAt && 'The email to you was not sent. '}
                        {!quote.confirmedAt && 'The confirmation to them was not sent.'}
                    </Callout>
                </div>
            )}

            <section className={frame.panel}>
                <div className={frame.stack}>
                    <Detail label="Email"><a href={`mailto:${quote.email}`} className={styles.plain}>{quote.email}</a></Detail>
                    {quote.company && <Detail label="Company">{quote.company}</Detail>}
                    {quote.website && <Detail label="Website"><External href={quote.website} /></Detail>}
                    {quote.projectType && <Detail label="Project type">{PROJECT_TYPE_LABELS[quote.projectType]}</Detail>}
                    {quote.budget && <Detail label="Budget">{BUDGET_LABELS[quote.budget]}</Detail>}
                    {quote.timeline && <Detail label="Timeline">{TIMELINE_LABELS[quote.timeline]}</Detail>}
                    {quote.referenceSites.length > 0 && (
                        <Detail label="Sites they like">
                            {quote.referenceSites.map(site => <div key={site}><External href={site} /></div>)}
                        </Detail>
                    )}
                    <hr className={frame.rule} />
                    <p className={styles.message}>{quote.message}</p>
                </div>
            </section>

            <div className={[frame.controls, styles.actions].join(' ')}>
                <StatusPicker quoteId={quote.id} status={quote.status} />
                <a
                    href={`mailto:${quote.email}?subject=${encodeURIComponent('Re: your quote request')}`}
                    className={[frame.action, frame.actionPrimary, styles.reply].join(' ')}
                >
                    Reply by email
                </a>
            </div>
            <div className={styles.quoteActions}>
                <QuoteActions quoteId={quote.id} archived={!!quote.archivedAt} emailsMissing={missing} />
            </div>

            <h2 className={styles.notesHead}>Notes</h2>
            <NoteForm quoteId={quote.id} />
            <div className={styles.notes}>
                {quote.notes.map(note => (
                    // The delete button sits outside the Row rather than in its aside: it shows its own
                    // error in a Callout, and Row's aside is a span, which cannot legally hold one.
                    <div key={note.id} className={styles.note}>
                        <Row title={<span className={styles.noteBody}>{note.body}</span>} sub={formatWhen(note.createdAt)} />
                        <DeleteNoteButton quoteId={quote.id} noteId={note.id} />
                    </div>
                ))}
            </div>
        </div>
    )
}
