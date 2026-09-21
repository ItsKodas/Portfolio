// Every transactional email the site sends, rendered from the same functions that send them, so a change to
// the shell can be looked at without putting anything in an inbox.

import { SITE } from '@/app/site'
import { emailChangedEmail, inviteEmail, passwordChangedEmail, resetEmail, twoFactorResetEmail } from '@/server/clients/emails'
import { confirmationEmail, notificationEmail, type QuoteForEmail } from '@/server/quotes/emails'
import { EmailPreview } from './emailPreview'
import styles from './gallery.module.css'

const client = { name: 'Ann Example', email: 'ann@example.com' }

const options = { from: `Horizons <hello@horizons.gg>`, replyTo: 'info@horizons.gg', siteUrl: SITE.url }

const quote: QuoteForEmail = {
    id: 'q1',
    createdAt: new Date('2026-09-20T09:14:00Z'),
    name: 'Ann Example',
    email: 'ann@example.com',
    company: 'Example Ltd',
    website: 'https://example.com',
    projectType: 'NEW_SITE',
    budget: 'FROM_5K_TO_10K',
    timeline: 'ONE_TO_THREE_MONTHS',
    message: 'We need a new site before our funding round.\n\nFive pages, a blog, and something that does not look like every other agency template.',
    referenceSites: ['https://one.example.com', 'https://two.example.com'],
}

const EMAILS = [
    {
        title: 'Client invite',
        note: 'The only email that hands over account access. The button and the address under it go to the same place, on purpose.',
        email: inviteEmail(client, 'i6Vi3ByAzg3ALPtKKoEC4', options),
    },
    {
        title: 'Password reset',
        note: 'Same shape as the invite, one hour instead of seven days.',
        email: resetEmail(client, 'Zxn0TcKG3TgYyhyF1ga6', options),
    },
    {
        title: 'Password changed',
        note: 'Blush, and no link anywhere in it. Check that before shipping any change to the shell.',
        email: passwordChangedEmail(client, options),
    },
    {
        title: 'Two factor reset',
        email: twoFactorResetEmail(client, options),
        note: 'Sent whenever the authenticator is cleared from the admin side, so it can never be silent.',
    },
    {
        title: 'Sign-in address changed',
        note: 'Goes to the old address as well as the new one, which is why the copy names the new address rather than assuming.',
        email: emailChangedEmail(client, { ...options, to: 'old@example.com' }),
    },
    {
        title: 'New quote',
        note: 'The one that comes to Koda. Reply-To is the prospect, so replying in Gmail answers them.',
        email: notificationEmail(quote, { from: options.from, to: 'koda@horizons.gg', siteUrl: SITE.url }),
    },
    {
        title: 'Quote confirmation',
        note: 'Repeats nothing the prospect typed except their name, and carries no link, so the form cannot be used to send text from this domain.',
        email: confirmationEmail(quote, options),
    },
]

export default function Emails() {
    return (
        <section className={`${styles.row} ${styles.emailsRow}`}>
            <h2 className={styles.title}>Emails</h2>
            <p className={styles.note}>
                All seven, built by the same functions that send them. They are dark because the site is, and
                every colour comes from the same tokens as the components above. Look for one whose spacing or
                weight has drifted from the others.
            </p>
            <div className={styles.emails}>
                {EMAILS.map(({ title, note, email }) => (
                    <EmailPreview key={title} title={title} note={note} html={email.html} />
                ))}
            </div>
        </section>
    )
}
