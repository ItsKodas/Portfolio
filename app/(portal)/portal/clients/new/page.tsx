import type { Metadata } from 'next'
import Link from 'next/link'

import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { quoteRepo } from '@/server/quotes/repo'
import { Callout } from '@/ui/Callout/Callout'
import AdminHeader from '../../adminHeader'
import frame from '../../frame.module.css'
import { ClientForm } from '../controls'

export const metadata: Metadata = { title: 'New client' }

export default async function NewClientPage({ searchParams }: { searchParams: Promise<{ fromQuote?: string }> }) {
    await requireAdmin()
    const { fromQuote } = await searchParams
    const quote = fromQuote ? await quoteRepo(getDb()).get(fromQuote) : null

    return (
        <div className={[frame.page, frame.sm].join(' ')}>
            <AdminHeader />
            <div className={frame.head}>
                <h1 className={frame.title}>New client</h1>
            </div>

            {fromQuote && !quote && (
                <div className={frame.subBlock}>
                    <Callout tone="warn" title="That quote could not be found.">Fill in the details by hand instead.</Callout>
                </div>
            )}
            {quote && (
                <div className={frame.subBlock}>
                    {/* Callout's title is a string, so the sentence with the link in it stays in the body,
                        word for word as the Alert had it, rather than being reworded to fit a heading. */}
                    <Callout title="Prefilled from a quote">
                        Prefilled from <Link href={`/admin/quotes/${quote.id}`} className={frame.link}>{quote.name}</Link>&apos;s quote.
                    </Callout>
                </div>
            )}

            <ClientForm fromQuoteId={quote?.id} initial={quote ? { name: quote.name, company: quote.company, email: quote.email } : undefined} />
        </div>
    )
}
