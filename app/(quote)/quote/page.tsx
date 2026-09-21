import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowBack } from '@/ui/icons'

import QuoteForm from './quoteForm'

// Rendered per request, so the Turnstile key below is read when the page is served. A NEXT_PUBLIC_ variable would be
// baked in at build time instead, and .env is deliberately left out of the Docker build.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
    title: 'Get a quote',
    description: "Tell me about the website or web app you have in mind, and I'll get back to you with a quote.",
    alternates: { canonical: '/quote' },
}

export default function QuotePage() {
    const siteKey = process.env.TURNSTILE_SITE_KEY
    const fallback = process.env.QUOTE_REPLY_TO

    return (
        <main className="min-h-full bg-[#0b101f] px-5 py-16 text-[#dbe6f7] sm:py-24">
            <div className="mx-auto max-w-2xl">
                <Link href="/" className="mb-10 inline-flex items-center gap-2 text-sm font-medium text-[#8fd4f5]/80 transition-colors hover:text-white">
                    <ArrowBack size={16} /> Horizons
                </Link>
                <h1 className="mb-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">Get a quote</h1>
                <p className="mb-10 max-w-xl text-base leading-relaxed text-[#b4c3dc]/80">
                    Tell me about the website or web app you have in mind. The more I know, the better the quote, but only
                    your name, email and a few words about the project are needed.
                </p>
                {siteKey
                    ? <QuoteForm siteKey={siteKey} />
                    : <p className="text-[#b4c3dc]/80">The form isn&apos;t available right now.{fallback && <> You can email <a className="text-[#8fd4f5] underline" href={`mailto:${fallback}`}>{fallback}</a> instead.</>}</p>}
            </div>
        </main>
    )
}
