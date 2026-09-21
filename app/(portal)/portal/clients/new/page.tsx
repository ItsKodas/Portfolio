import type { Metadata } from 'next'
import Link from 'next/link'
import { Alert, Container, Typography } from '@mui/material'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { quoteRepo } from '@/server/quotes/repo'
import AdminHeader from '../../adminHeader'
import { ClientForm } from '../controls'

export const metadata: Metadata = { title: 'New client' }

export default async function NewClientPage({ searchParams }: { searchParams: Promise<{ fromQuote?: string }> }) {
    await requireAdmin()
    const { fromQuote } = await searchParams
    const quote = fromQuote ? await quoteRepo(getDb()).get(fromQuote) : null

    return (
        <Container maxWidth="sm" sx={{ pb: 6 }}>
            <AdminHeader />
            <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 1 }}>New client</Typography>

            {fromQuote && !quote && (
                <Alert severity="warning" sx={{ mb: 3 }}>That quote could not be found. Fill in the details by hand instead.</Alert>
            )}
            {quote && (
                <Alert severity="info" sx={{ mb: 3 }}>
                    Prefilled from <Link href={`/admin/quotes/${quote.id}`} style={{ color: 'inherit' }}>{quote.name}</Link>&apos;s quote.
                </Alert>
            )}

            <ClientForm fromQuoteId={quote?.id} initial={quote ? { name: quote.name, company: quote.company, email: quote.email } : undefined} />
        </Container>
    )
}
