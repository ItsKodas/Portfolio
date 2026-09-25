// The Domains section of the Environments tab, for the environment chosen there. Two screens over one
// list, which is why this takes its domains as a prop rather than asking hostd itself the way DeployPanel
// does: an operator gets a table of hostnames, states and the controls that change them, and a client gets
// sentences about their own website address and nothing else. Both are worth rendering in a test without
// a network in the way.
//
// A client reads this at all because hostd leaves 'domains-read' out of its admin-only policy verbs
// (hostd/src/api/policy.ts). Every verb that changes something is admin-only, verifying included, so
// every control below sits inside the operator's half.

import type { Domain } from '@/server/hostd/domains'
import { LIVE, type EnvironmentName } from '@/server/hostd/env'
import { Callout } from '@/ui/Callout/Callout'
import { DataTable } from '@/ui/DataTable/DataTable'
import { StatusDot, type State as DotState } from '@/ui/StatusDot/StatusDot'
import { AddDomain, AdoptSite, DomainActions } from './domainControls'
import { clientSentence, needsYou, sortDomains, stateTone, stateWord } from './domains'
import { formatWhen } from '../../format'
import styles from './site.module.css'

// ui/StatusDot draws container states, and a domain is not a container. The tone is the thing both have
// in common, so it is what maps: green for a name that answers, amber for one not verified yet, red
// for one that gave up, grey for one hostd does not own. The word beside the dot is stateWord's, and it
// is the word that carries the meaning; the dot is colour.
const DOTS: Record<'good' | 'warn' | 'crit' | 'idle', DotState> = {
    good: 'up',
    warn: 'paused',
    crit: 'down',
    idle: 'stopped',
}

// hostd's own two modes, spelled the way somebody says them out loud. null is an environment with no
// certificate mode set, which is not a fault on its own.
const CERTIFICATES: Record<string, string> = {
    'cloudflare-origin': 'Cloudflare origin',
    letsencrypt: "Let's Encrypt",
}

function when(iso: string | null): string {
    if (!iso) return 'never'
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? iso : formatWhen(at)
}

// Why this row wants the operator. hostd's own sentence when it wrote one, and otherwise the fact that
// a vhost was rolled back, which is the other thing needsYou counts.
function why(domain: Domain): string {
    if (domain.error) return domain.error
    if (domain.vhost && !domain.vhost.ok) return 'Apache refused the file, so hostd put the previous one back.'
    return 'hostd gave no reason.'
}

const COLUMNS = [
    { key: 'hostname', head: 'hostname' },
    { key: 'role', head: 'role' },
    { key: 'state', head: 'state' },
    { key: 'certificate', head: 'certificate' },
    { key: 'checked', head: 'last checked' },
    { key: 'reason', head: 'needs you' },
    { key: 'act', head: 'change it' },
]

type Props = {
    id: string
    // The environment chosen in the Environments tab's list. The list is the selector, so this draws none.
    environment: EnvironmentName
    domains: Domain[]
    isAdmin: boolean
    // hostd makes an adoption name the project back before it will replace a live vhost, and it is the
    // name it asks for rather than the id.
    projectName: string
    // Why the list is empty, when it is empty because nobody could read it. hostd's own words for the
    // operator and a plain sentence for a client, decided before it reaches here.
    trouble: string | null
}

// The environment's main address, shown and not changed here. live's is changed from Settings, where a
// change to the address the site answers on sits beside the site's other settings. Any other environment's
// is given when it is created.
function MainAddress({ environment, current }: { environment: EnvironmentName, current: string | null }) {
    return (
        <section className={styles.block} aria-labelledby="main-address">
            <h2 id="main-address">Main address</h2>
            {current
                ? <p className={styles.addressName}>{current}</p>
                : <p className={styles.empty}>
                    This environment has no main address yet. The first address added below becomes it.
                </p>}
            {environment === LIVE && (
                <p className={styles.note}>live&apos;s main address is set and changed from this site&apos;s Settings tab.</p>
            )}
        </section>
    )
}

export function DomainsPanel({ id, environment, domains, isAdmin, projectName, trouble }: Props) {
    const ordered = sortDomains(domains)

    // A client asked one question: does my website address work. They get the answer to it. No table, no
    // certificate mode, no environment strip, and nothing they could act on, because there is nothing
    // here they are allowed to act on.
    if (!isAdmin) {
        return (
            <section className={styles.block}>
                <h2>{ordered.length === 1 ? 'Your website address' : 'Your website addresses'}</h2>
                {trouble
                    ? <Callout tone="warn" title="This could not be checked just now">{trouble}</Callout>
                    : ordered.length === 0
                        ? <p className={styles.empty}>No address is set up for your site yet.</p>
                        : ordered.map(domain => (
                            <div className={styles.address} key={domain.hostname}>
                                {/* Their own domain name, which is the one thing here that is theirs
                                    rather than ours. Two sites with the same sentence and no name over
                                    it would be two identical paragraphs. */}
                                <p className={styles.addressName}>{domain.hostname}</p>
                                <p>{clientSentence(domain)}</p>
                            </div>
                        ))}
                <p className={styles.note}>
                    Ask Koda if any of this looks wrong, or if you want another name pointed at your site.
                </p>
            </section>
        )
    }

    // The environment's address, or null when it has none. The list is what hostd answers about the
    // registry entry, so no primary row means no domain key on the entry, which is the state every site
    // enrolled by hand is in.
    const primary = ordered.find(domain => domain.primary)?.hostname ?? null

    const rows = ordered.map(domain => ({
        hostname: <span className={styles.mono}>{domain.hostname}</span>,
        role: domain.primary ? 'primary' : 'alias',
        state: <StatusDot state={DOTS[stateTone(domain.state)]} label={stateWord(domain.state)} />,
        certificate: CERTIFICATES[domain.certificate ?? ''] ?? 'none set',
        checked: when(domain.checkedAt),
        reason: needsYou(domain)
            ? (
                <>
                    <span className={styles.stateBad}>{why(domain)}</span>
                    {/* Apache's own words about a file it refused, folded away: it is the one thing an
                        operator opens when a reload went wrong, and six lines of it in a table cell
                        would make every other row unreadable. */}
                    {domain.vhost && !domain.vhost.ok && (
                        <details className={styles.outputBlock}>
                            <summary>What Apache said</summary>
                            <pre>{domain.vhost.output}</pre>
                        </details>
                    )}
                </>
            )
            : null,
        // hostd has not written the file this name is served from, so the only thing on offer is taking
        // it over, and that is per environment rather than per name.
        act: domain.state === 'unmanaged'
            ? <AdoptSite id={id} environment={environment} projectName={projectName} />
            : <DomainActions id={id} environment={environment} hostname={domain.hostname} removable={!domain.primary} />,
    }))

    return (
        <>
            {trouble && (
                <div className={styles.said}>
                    <Callout tone="warn" title="The addresses could not be read">{trouble}</Callout>
                </div>
            )}

            {!trouble && (
                <>
                    {/* hostd makes the first hostname an environment gets its primary, so the add form is
                        open with or without one. Keyed on the environment: the list switches it by
                        navigating to this same route, which rerenders rather than remounts, and a hostname
                        typed for one environment must not be sent to the next. */}
                    <MainAddress environment={environment} current={primary} />
                    <AddDomain key={environment} id={id} environment={environment} />

                    <section className={styles.block}>
                        <h2>Addresses</h2>
                        <DataTable
                            label={`${environment} addresses`}
                            columns={COLUMNS}
                            rows={rows}
                            empty="No address is set up for this environment yet."
                        />
                    </section>
                </>
            )}
        </>
    )
}
