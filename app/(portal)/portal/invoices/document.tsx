// The invoice as the portal shows it, on the operator's page and the client's alike, with the same facts the PDF
// carries. A server component: it only reads.

import type { Business } from '@/server/invoices/business'
import { formatDay, todayIn, type Day } from '@/server/invoices/days'
import { formatMoney, formatQuantity, GST_RATE } from '@/server/invoices/money'
import type { InvoiceView } from '@/server/invoices/repo'
import { invoiceNumber, STANDING_LABELS, STANDING_TONES, standingOf } from '@/server/invoices/standing'
import { paidCentsOf } from '@/server/invoices/billing'
import { Chip } from '@/ui/Chip/Chip'
import styles from './invoices.module.css'

export function InvoiceDocument({ invoice, business, today }: { invoice: InvoiceView, business: Business, today: Day }) {
    const standing = standingOf(invoice, today)
    const paid = paidCentsOf(invoice)
    const balance = Math.max(0, invoice.totalCents - paid)
    const money = (cents: number) => formatMoney(cents, invoice.currency)

    return (
        <article className={styles.document} aria-label={`Invoice ${invoiceNumber(invoice.number)}`}>
            <header className={styles.docHead}>
                <div>
                    <p className={styles.business}>{business.name}</p>
                    <p className={styles.muted}>ABN {business.abn}</p>
                    {business.address.map(line => <p key={line} className={styles.muted}>{line}</p>)}
                    <p className={styles.muted}>{business.email}</p>
                </div>
                <div className={styles.docFacts}>
                    <p className={styles.docTitle}>{invoice.gst ? 'Tax invoice' : 'Invoice'}</p>
                    <dl className={styles.facts}>
                        <dt>Number</dt><dd>{invoiceNumber(invoice.number)}</dd>
                        <dt>Issued</dt><dd>{invoice.issuedOn ? formatDay(invoice.issuedOn) : 'Not yet sent'}</dd>
                        <dt>Due</dt><dd>{formatDay(invoice.dueOn)}</dd>
                    </dl>
                    <Chip tone={STANDING_TONES[standing]}>{STANDING_LABELS[standing]}</Chip>
                </div>
            </header>

            <section className={styles.billTo}>
                <p className={styles.label}>Bill to</p>
                <p className={styles.strong}>{invoice.billToName}</p>
                {invoice.billToCompany && <p>{invoice.billToCompany}</p>}
                <p className={styles.muted}>{invoice.billToEmail}</p>
                {invoice.periodStart && invoice.periodEnd && (
                    <p className={styles.period}>Service period: {formatDay(invoice.periodStart)} to {formatDay(invoice.periodEnd)}</p>
                )}
            </section>

            <div className={styles.linesWrap}>
                <table className={styles.lines}>
                    <thead>
                        <tr>
                            <th scope="col">Description</th>
                            <th scope="col" className={styles.num}>Qty</th>
                            <th scope="col" className={styles.num}>Unit price</th>
                            <th scope="col" className={styles.num}>Amount</th>
                        </tr>
                    </thead>
                    <tbody>
                        {invoice.lines.map(line => (
                            <tr key={line.id}>
                                <td className={styles.description}>{line.description}</td>
                                <td className={styles.num}>{formatQuantity(line.quantity)}</td>
                                <td className={styles.num}>{money(line.unitCents)}</td>
                                <td className={styles.num}>{money(line.amountCents)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <dl className={styles.totals}>
                <dt>Subtotal</dt><dd>{money(invoice.subtotalCents)}</dd>
                {invoice.gst && <><dt>GST ({GST_RATE * 100}%)</dt><dd>{money(invoice.gstCents)}</dd></>}
                <dt className={styles.strong}>Total ({invoice.currency})</dt><dd className={styles.strong}>{money(invoice.totalCents)}</dd>
                {paid > 0 && <><dt>Paid{invoice.paidAt ? ` ${formatDay(todayIn(invoice.paidAt))}` : ''}</dt><dd>-{money(paid)}</dd></>}
                {standing !== 'void' && <><dt className={styles.strong}>Balance due</dt><dd className={styles.strong}>{money(balance)}</dd></>}
            </dl>
            {!invoice.gst && <p className={styles.gstNote}>No GST has been charged.</p>}

            {invoice.notes && (
                <section className={styles.notes}>
                    <p className={styles.label}>Notes</p>
                    <p className={styles.notesText}>{invoice.notes}</p>
                </section>
            )}
        </article>
    )
}
