import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { TOKEN_REMOVED } from '@/server/audit/emails'
import { auditRepo } from '@/server/audit/read'
import { requireAdmin } from '@/server/auth'
import { getDb } from '@/server/db'
import { Callout } from '@/ui/Callout/Callout'
import { KeyValue } from '@/ui/KeyValue/KeyValue'
import { formatWhen } from '../../../format'
import frame from '../../../frame.module.css'
import PortalHeader from '../../../header'
import { EmailFrame } from '../../emailFrame'
import styles from '../../logs.module.css'

export const metadata: Metadata = { title: 'Email' }

// One email, whole: who it went to, and both versions of what it said
export default async function SentEmail({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin()
    const { id } = await params
    const email = await auditRepo(getDb()).email(id)
    if (!email) notFound()

    return (
        <>
            <PortalHeader admin />
            <div className={[frame.page, frame.md].join(' ')}>
                <p className={frame.sub}>
                    <Link href="/portal/logs/emails" className={frame.link}>Emails</Link>
                </p>
                <div className={frame.head}>
                    <h1 className={frame.title}>{email.subject}</h1>
                </div>

                {email.error && <Callout tone="crit" title="The relay refused this email">{email.error}</Callout>}

                <KeyValue pairs={[
                    { key: 'Sent', value: formatWhen(email.createdAt) },
                    { key: 'To', value: email.to },
                    { key: 'From', value: email.from },
                    { key: 'Reply to', value: email.replyTo },
                ]} />

                {email.text.includes(TOKEN_REMOVED) && (
                    <p className={frame.sub}>The link in this email had a one-time token in it, which is not kept.</p>
                )}

                <h2 className={styles.section}>As it looked</h2>
                <EmailFrame title={email.subject} html={email.html} />

                <h2 className={styles.section}>Plain text</h2>
                <pre className={styles.text}>{email.text}</pre>
            </div>
        </>
    )
}
