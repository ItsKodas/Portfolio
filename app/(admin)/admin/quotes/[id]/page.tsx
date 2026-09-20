import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Alert, Box, Button, Chip, Container, Divider, Paper, Stack, Typography } from '@mui/material'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { emailsMissing } from '@/server/quotes/emails'
import { BUDGET_LABELS, PROJECT_TYPE_LABELS, STATUS_LABELS, TIMELINE_LABELS } from '@/server/quotes/labels'
import { quoteRepo } from '@/server/quotes/repo'
import { STATUS_COLOURS, formatWhen } from '../../format'
import AdminHeader from '../../header'
import { DeleteNoteButton, NoteForm, QuoteActions, StatusPicker } from './controls'

export const metadata: Metadata = { title: 'Quote' }

// Links the prospect typed in: only ever http or https (the schema refuses anything else), opened without telling the
// other site where the click came from
function External({ href }: { href: string }) {
    return <a href={href} target="_blank" rel="noopener noreferrer nofollow" style={{ color: 'inherit', wordBreak: 'break-all' }}>{href}</a>
}

function Detail({ label, children }: { label: string, children: React.ReactNode }) {
    return (
        <Box>
            <Typography variant="caption" color="text.secondary" component="p">{label}</Typography>
            <Typography component="div">{children}</Typography>
        </Box>
    )
}

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin()
    const { id } = await params
    const quote = await quoteRepo(getDb()).get(id)
    if (!quote) notFound()
    const missing = emailsMissing(quote, new Date())

    return (
        <Container maxWidth="md" sx={{ pb: 6 }}>
            <AdminHeader />
            <Stack direction="row" sx={{ alignItems: 'center', gap: 2, mb: 1, flexWrap: 'wrap' }}>
                <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>{quote.name}</Typography>
                <Chip label={STATUS_LABELS[quote.status]} color={STATUS_COLOURS[quote.status]} />
                {quote.archivedAt && <Chip label="Archived" variant="outlined" />}
                {quote.client
                    ? (
                        <Button component={Link} href={`/admin/clients/${quote.client.id}`} variant="outlined" size="small">
                            Client: {quote.client.company ?? quote.client.name}
                        </Button>
                    )
                    : quote.status === 'WON' && (
                        <Button component={Link} href={`/admin/clients/new?fromQuote=${quote.id}`} variant="contained" size="small">
                            Create client from this quote
                        </Button>
                    )}
            </Stack>
            <Typography color="text.secondary" sx={{ mb: 3 }}>Received {formatWhen(quote.createdAt)}</Typography>

            {missing && (
                <Alert severity="warning" sx={{ mb: 3 }}>
                    {!quote.notifiedAt && 'The email to you was not sent. '}
                    {!quote.confirmedAt && 'The confirmation to them was not sent.'}
                </Alert>
            )}

            <Paper sx={{ p: 3, mb: 3 }}>
                <Stack sx={{ gap: 2 }}>
                    <Detail label="Email"><a href={`mailto:${quote.email}`} style={{ color: 'inherit' }}>{quote.email}</a></Detail>
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
                    <Divider />
                    <Typography sx={{ whiteSpace: 'pre-wrap' }}>{quote.message}</Typography>
                </Stack>
            </Paper>

            <Stack direction="row" sx={{ gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <StatusPicker quoteId={quote.id} status={quote.status} />
                <Button variant="contained" href={`mailto:${quote.email}?subject=${encodeURIComponent('Re: your quote request')}`}>Reply by email</Button>
            </Stack>
            <Box sx={{ mb: 4 }}>
                <QuoteActions quoteId={quote.id} archived={!!quote.archivedAt} emailsMissing={missing} />
            </Box>

            <Typography variant="h6" component="h2" sx={{ mb: 2 }}>Notes</Typography>
            <NoteForm quoteId={quote.id} />
            <Stack sx={{ gap: 1.5, mt: 3 }}>
                {quote.notes.map(note => (
                    <Paper key={note.id} variant="outlined" sx={{ p: 2, display: 'flex', gap: 1 }}>
                        <Box sx={{ flex: 1 }}>
                            <Typography variant="caption" color="text.secondary">{formatWhen(note.createdAt)}</Typography>
                            <Typography sx={{ whiteSpace: 'pre-wrap' }}>{note.body}</Typography>
                        </Box>
                        <DeleteNoteButton quoteId={quote.id} noteId={note.id} />
                    </Paper>
                ))}
            </Stack>
        </Container>
    )
}
