import { pdfInvoiceOf } from '@/server/invoices/billing'
import { todayIn } from '@/server/invoices/days'
import { invoiceNumber } from '@/server/invoices/standing'
import { billingViewer } from '@/server/invoices/viewer'
import { drawPdf, invoices, log } from '@/server/invoices/wiring'

export const dynamic = 'force-dynamic'

// An invoice as a PDF. The operator may have any of them; a client only their own, and never a draft.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const viewer = await billingViewer()
    if (!viewer) return new Response('Sign in first.', { status: 403 })

    const invoice = await invoices().get(id)
    const mayRead = invoice && (viewer === 'admin' || (invoice.clientId === viewer.clientId && invoice.status !== 'DRAFT'))
    if (!invoice || !mayRead) return new Response('Not found.', { status: 404 })

    try {
        const pdf = await drawPdf(pdfInvoiceOf(invoice, todayIn(new Date())))
        return new Response(new Uint8Array(pdf), {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${invoiceNumber(invoice.number)}.pdf"`,
                'Cache-Control': 'private, no-store',
            },
        })
    } catch (error) {
        log(`Drawing the PDF of ${id} failed`, error)
        return new Response('The PDF could not be made. Please try again.', { status: 500 })
    }
}
