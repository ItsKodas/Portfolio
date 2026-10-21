'use client'

// "Email me": opens a mail to Koda. The address is never in the page, as text or as a mailto link, because harvesters
// scrape both; it is kept as character codes and only put together when someone actually clicks.
const ADDRESS = [107, 111, 100, 97, 64, 104, 111, 114, 105, 122, 111, 110, 115, 46, 103, 103]

export default function EmailLink({ className = '' }: { className?: string }) {
    return (
        <button type="button" onClick={() => window.location.assign(`mailto:${String.fromCharCode(...ADDRESS)}`)}
            className={`inline-flex items-center gap-2 rounded-full border border-[#b597cc]/35 bg-[#b597cc]/[0.07] px-5 py-2.5 text-sm font-semibold text-[#d9c6ea] transition-colors hover:border-[#b597cc]/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b597cc]/50 ${className}`}>
            Email me
        </button>
    )
}
