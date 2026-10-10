import type { Metadata } from 'next'

import { requireClient } from '@/server/clients/auth'
import { currentImpersonation } from '@/server/clients/impersonating'
import { describeDevice } from '@/server/clients/account'
import { RECOVERY_CODE_COUNT } from '@/server/clients/setup'
import { repo } from '@/server/clients/wiring'
import { Chip } from '@/ui/Chip/Chip'
import { formatWhen } from '../format'
import PortalHeader from '../header'
import frame from '../frame.module.css'
import { ChangePasswordForm, RegenerateCodesForm, SignOutElsewhereButton } from '../forms'
import { saveMyPublicContactAction } from '../actions'
import { PublicContactForm } from '../publicContact/form'
import styles from './account.module.css'

export const metadata: Metadata = { title: 'Account' }

export default async function PortalAccountPage() {
    // The operator viewing as a client sees that this page exists and nothing on it they could use. A
    // client's password, second factor, recovery codes and sessions are theirs alone: the actions behind
    // these forms take the client's own session (requireClient), which viewing as them never carries.
    const viewing = await currentImpersonation()
    if (viewing) {
        return (
            <>
                <PortalHeader admin={false} name={viewing.client.name} viewingAs={viewing.client.name} />
                <div className={[frame.page, frame.md].join(' ')}>
                    <div className={frame.head}>
                        <h1 className={frame.title}>Account</h1>
                    </div>
                    <section className={frame.panel}>
                        <p className={styles.count}>
                            {viewing.client.name} changes their own password, two-step sign-in, recovery codes and
                            sessions here. None of it can be changed while you are viewing as them.
                        </p>
                    </section>
                </div>
            </>
        )
    }

    const { client, sessionId } = await requireClient()
    const [sessions, unusedCodes] = await Promise.all([
        repo().listSessions(client.id),
        repo().countUnusedRecoveryCodes(client.id),
    ])

    return (
        <>
            <PortalHeader admin={false} name={client.name} />
            <div className={[frame.page, frame.md].join(' ')}>
                <div className={frame.head}>
                    <h1 className={frame.title}>Account</h1>
                </div>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Contact details for visitors</h2>
                    <PublicContactForm
                        intro="If one of your sites is ever down, its holding page can show visitors how to reach your business. Use your business name and business details, not personal ones."
                        initial={{ name: client.publicName, email: client.publicEmail, phone: client.publicPhone }}
                        listed={{ value: client.publicContactListed, editable: false }}
                        save={saveMyPublicContactAction}
                    />
                </section>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Password</h2>
                    <ChangePasswordForm />
                </section>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Where you are signed in</h2>
                    <div className={styles.sessions}>
                        {sessions.map(session => (
                            <div key={session.id} className={styles.session}>
                                <div className={styles.device}>
                                    <span className={styles.deviceName}>{describeDevice(session.userAgent)}</span>
                                    {session.id === sessionId && <Chip>This device</Chip>}
                                </div>
                                <p className={styles.lastUsed}>Last used {formatWhen(session.lastUsedAt)}</p>
                            </div>
                        ))}
                    </div>
                    {sessions.length > 1 && <SignOutElsewhereButton />}
                </section>

                <section className={frame.panel}>
                    <h2 className={frame.section}>Recovery codes</h2>
                    <p className={styles.count}>{unusedCodes} of {RECOVERY_CODE_COUNT} unused</p>
                    <RegenerateCodesForm />
                </section>
            </div>
        </>
    )
}
