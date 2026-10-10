import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireAdmin } from '@/server/auth'
import { repo } from '@/server/clients/wiring'
import { getDb } from '@/server/db'
import { quoteRepo } from '@/server/quotes/repo'
import { formatDayShort, todayIn } from '@/server/invoices/days'
import { formatMoney } from '@/server/invoices/money'
import { autopayActive, INTERVAL_LABELS, nextBillingDay } from '@/server/invoices/plans'
import { invoiceNumber, STANDING_LABELS, STANDING_TONES, standingOf } from '@/server/invoices/standing'
import { invoices as invoiceRepo, paypalMode, plans as planRepo } from '@/server/invoices/wiring'
import { Button } from '@/ui/Button/Button'
import { Chip } from '@/ui/Chip/Chip'
import { formatWhen } from '../../format'
import PortalHeader from '../../header'
import frame from '../../frame.module.css'
import { AccessRow, GrantSiteForm } from '../../access/controls'
import {
    ClearLockButton, ClientForm, ClientId, DeleteClientButton,
    ResendInviteButton, ResetTwoFactorButton, SendResetButton, SuspendButton,
} from '../controls'
import { STATE_TONES, clientState } from '../state'
import { savePublicContactAction } from '../actions'
import { PublicContactForm } from '../../publicContact/form'
import { startViewingAsAction } from '../../viewAs/actions'
import { EditPlan, EndPlanButton, PlanForm, StopAutopayButton } from '../../invoices/controls'
import invoiceStyles from '../../invoices/invoices.module.css'
import styles from './client.module.css'

export const metadata: Metadata = { title: 'Client' }

function Detail({ label, children }: { label: string, children: React.ReactNode }) {
    return (
        <div>
            <p className={styles.label}>{label}</p>
            <div className={styles.value}>{children}</div>
        </div>
    )
}

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin()
    const { id } = await params
    const clients = repo()
    const client = await clients.byId(id)
    if (!client) notFound()

    const now = new Date()
    const today = todayIn(now)
    const [access, sessions, unusedRecoveryCodes, quotes, plans, invoices, sites] = await Promise.all([
        clients.listAccess(id),
        clients.listSessions(id),
        clients.countUnusedRecoveryCodes(id),
        quoteRepo(getDb()).listForClient(id),
        planRepo().list({ clientId: id }),
        invoiceRepo().list({ standing: null, clientId: id }, today),
        planRepo().sites(),
    ])

    const state = clientState(client, now)
    const mode = paypalMode()

    return (
        <>
            <PortalHeader admin />
            <div className={[frame.page, frame.md].join(' ')}>
                <div className={[frame.head, frame.headCentred].join(' ')}>
                    <h1 className={frame.title}>{client.name}</h1>
                    <Chip tone={STATE_TONES[state]}>{state}</Chip>
                </div>
                <div className={frame.subBlock}><ClientId id={client.id} /></div>

                {/* Not offered for a suspended client: they cannot sign in, so there is nothing of theirs to see */}
                {!client.suspendedAt && (
                    <section className={frame.panel}>
                        <h2 className={frame.section}>View as client</h2>
                        <p className={frame.empty}>
                            See the portal exactly as {client.name} does: their sites, the tabs and controls their
                            access allows, and nothing else. Their password and two-step sign-in stay out of reach.
                        </p>
                        <form action={startViewingAsAction.bind(null, client.id)} className={frame.controls}>
                            <Button type="submit">View as client</Button>
                        </form>
                    </section>
                )}

                <section className={frame.panel}>
                    <ClientForm clientId={client.id} initial={{ name: client.name, company: client.company, email: client.email }} />
                </section>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Public contact</h2>
                    <PublicContactForm
                        intro="Shown to visitors on their sites' holding page while a site is down, once ticked. The client can edit these from their own account page too."
                        initial={{ name: client.publicName, email: client.publicEmail, phone: client.publicPhone }}
                        listed={{ value: client.publicContactListed, editable: true }}
                        save={savePublicContactAction.bind(null, client.id)}
                    />
                </section>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Account</h2>
                    <div className={frame.stack}>
                        <Detail label="Last sign-in">{client.lastSignInAt ? formatWhen(client.lastSignInAt) : 'Never'}</Detail>
                        <Detail label="Recovery codes remaining">{unusedRecoveryCodes}</Detail>
                        <Detail label="Sessions">
                            {sessions.length === 0 ? 'None' : (
                                <div className={styles.sessions}>
                                    {sessions.map(session => (
                                        <p key={session.id} className={styles.session}>
                                            {formatWhen(session.lastUsedAt)}{session.mfaAt ? '' : ' (not yet verified)'}
                                            {session.userAgent && ` (${session.userAgent})`}
                                        </p>
                                    ))}
                                </div>
                            )}
                        </Detail>
                    </div>
                    <hr className={frame.rule} />
                    <div className={frame.controls}>
                        {!client.passwordHash && <ResendInviteButton clientId={client.id} />}
                        <SendResetButton clientId={client.id} />
                        <ResetTwoFactorButton clientId={client.id} />
                        <SuspendButton clientId={client.id} suspended={!!client.suspendedAt} />
                        {client.lockedUntil && client.lockedUntil.getTime() > now.getTime() && <ClearLockButton clientId={client.id} />}
                        <DeleteClientButton clientId={client.id} />
                    </div>
                </section>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Sites</h2>
                    <div className={styles.sites}>
                        {access.length === 0 ? <p className={frame.empty}>No access to any site yet.</p> : access.map(row => (
                            <AccessRow
                                key={row.siteId}
                                clientId={client.id}
                                siteId={row.siteId}
                                title={row.site.name}
                                subtitle={row.site.projectId}
                                href={`/portal/sites/${row.site.projectId}`}
                                permissions={row.permissions}
                            />
                        ))}
                    </div>
                    <GrantSiteForm clientId={client.id} />
                </section>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Plans</h2>
                    {plans.length === 0 ? <p className={frame.empty}>No plans. Add one below for anything charged on repeat, such as hosting.</p> : (
                        <div className={invoiceStyles.plans}>
                            {plans.map(plan => {
                                const automatic = autopayActive(plan, mode)
                                return (
                                    <div key={plan.id}>
                                        <div className={invoiceStyles.plan}>
                                            <div>
                                                <p className={invoiceStyles.planName}>
                                                    {plan.description}{' '}
                                                    {plan.amountCents === 0 ? 'Not charged' : `${formatMoney(plan.amountCents)} a ${INTERVAL_LABELS[plan.interval]}`}
                                                </p>
                                                <p className={invoiceStyles.planMeta}>
                                                    {plan.site ? `${plan.site.name}. ` : ''}
                                                    {plan.amountCents === 0 ? 'Listed for the client, never invoiced.'
                                                        : automatic ? 'Paid automatically with PayPal.'
                                                            : `Next invoice ${formatDayShort(nextBillingDay(plan))}, due ${plan.dueDays} days after.`}
                                                    {plan.subscriptionStatus === 'SUSPENDED' && ' Automatic payment is failing, so it is invoiced instead.'}
                                                </p>
                                            </div>
                                            <div className={frame.controls}>
                                                {automatic && <StopAutopayButton planId={plan.id} />}
                                                <EndPlanButton planId={plan.id} autopay={automatic} />
                                            </div>
                                        </div>
                                        <EditPlan
                                            clientId={client.id}
                                            planId={plan.id}
                                            sites={sites}
                                            billed={plan.periodsBilled > 0}
                                            initial={{
                                                description: plan.description, amountCents: plan.amountCents, interval: plan.interval,
                                                startsOn: plan.startsOn, dueDays: plan.dueDays, siteId: plan.siteId,
                                            }}
                                        />
                                    </div>
                                )
                            })}
                        </div>
                    )}
                    <hr className={frame.rule} />
                    <PlanForm
                        clientId={client.id}
                        sites={sites}
                        initial={{ description: 'Website hosting', amountCents: null, interval: 'MONTHLY', startsOn: today, dueDays: 14, siteId: null }}
                    />
                </section>

                <section className={frame.panel}>
                    <div className={[frame.head, frame.headSpread].join(' ')}>
                        <h2 className={frame.section}>Invoices</h2>
                        <Link href={`/portal/invoices/new?client=${client.id}`} className={[frame.action, frame.actionSmall].join(' ')}>New invoice</Link>
                    </div>
                    {invoices.length === 0 ? <p className={frame.empty}>No invoices yet.</p> : (
                        <div className={styles.quotes}>
                            {invoices.map(invoice => {
                                const standing = standingOf(invoice, today)
                                return (
                                    <p key={invoice.id} className={styles.quote}>
                                        <Link href={`/portal/invoices/${invoice.id}`} className={frame.plainLink}>{invoiceNumber(invoice.number)}</Link>
                                        <span className={styles.quoteWhen}> {formatMoney(invoice.totalCents, invoice.currency)}, due {formatDayShort(invoice.dueOn)} </span>
                                        <Chip tone={STANDING_TONES[standing]}>{STANDING_LABELS[standing]}</Chip>
                                    </p>
                                )
                            })}
                        </div>
                    )}
                </section>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Linked quotes</h2>
                    {quotes.length === 0 ? <p className={frame.empty}>No quotes linked.</p> : (
                        <div className={styles.quotes}>
                            {quotes.map(quote => (
                                <p key={quote.id} className={styles.quote}>
                                    <Link href={`/admin/quotes/${quote.id}`} className={frame.plainLink}>{quote.name}</Link>
                                    <span className={styles.quoteWhen}> ({formatWhen(quote.createdAt)})</span>
                                </p>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </>
    )
}
