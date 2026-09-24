import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requireAdmin } from '@/server/auth'
import { repo } from '@/server/clients/wiring'
import { getDb } from '@/server/db'
import { quoteRepo } from '@/server/quotes/repo'
import { Chip } from '@/ui/Chip/Chip'
import { formatWhen } from '../../format'
import PortalHeader from '../../header'
import frame from '../../frame.module.css'
import {
    AddSiteForm, ClearLockButton, ClientForm, ClientId, DeleteClientButton, RemoveSiteButton,
    ResendInviteButton, ResetTwoFactorButton, SendResetButton, SuspendButton,
} from '../controls'
import { STATE_TONES, clientState } from '../state'
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

    const [sites, sessions, unusedRecoveryCodes, quotes] = await Promise.all([
        clients.listSites(id),
        clients.listSessions(id),
        clients.countUnusedRecoveryCodes(id),
        quoteRepo(getDb()).listForClient(id),
    ])

    const now = new Date()
    const state = clientState(client, now)

    return (
        <>
            <PortalHeader admin />
            <div className={[frame.page, frame.md].join(' ')}>
                <div className={[frame.head, frame.headCentred].join(' ')}>
                    <h1 className={frame.title}>{client.name}</h1>
                    <Chip tone={STATE_TONES[state]}>{state}</Chip>
                </div>
                <div className={frame.subBlock}><ClientId id={client.id} /></div>

                <section className={frame.panel}>
                    <ClientForm clientId={client.id} initial={{ name: client.name, company: client.company, email: client.email }} />
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
                        {sites.length === 0 ? <p className={frame.empty}>No sites linked yet.</p> : sites.map(site => (
                            <div key={site.id} className={styles.site}>
                                <p className={styles.siteName}>{site.name} <span className={frame.mono}>{site.projectId}</span></p>
                                <RemoveSiteButton clientId={client.id} siteId={site.id} />
                            </div>
                        ))}
                    </div>
                    <AddSiteForm clientId={client.id} />
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
