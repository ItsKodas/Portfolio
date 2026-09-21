import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { readHostd } from '@/server/hostd/config'
import { getHealth, type Health, type SystemUsage } from '@/server/hostd/health'
import { listProjects, type Project, type ServiceStatus } from '@/server/hostd/projects'
import { callerFromSession } from '@/server/hostd/session'
import { Callout } from '@/ui/Callout/Callout'
import { KeyValue } from '@/ui/KeyValue/KeyValue'
import { Meter } from '@/ui/Meter/Meter'
import { Row } from '@/ui/Row/Row'
import { Shell } from '@/ui/Shell/Shell'
import { StatStrip } from '@/ui/StatStrip/StatStrip'
import { StatusDot } from '@/ui/StatusDot/StatusDot'
import { gatherHome, type HomeView } from './home'
import styles from './portal.module.css'

export const metadata: Metadata = { title: 'Portal' }
export const dynamic = 'force-dynamic'

// A reading hostd could not take is said to be missing, never shown as zero: an unread figure and a figure
// that is genuinely nothing look identical once they are both printed as 0, and only one of them is true.
const NOT_AVAILABLE = 'not available'

// What a list actually carries. hostd answers /projects?status=1 with a status object per project
// (hostd/src/api/routes.ts builds it, hostd/src/shared/protocol.ts types it) and puts its refusal inside
// that object rather than failing the whole list, so both arms have to be handled. The bare `services`
// field is what a single project read answers with, kept here as a fallback so this reads either shape.
function servicesOf(site: Project): ServiceStatus[] | null {
    if (site.status) return site.status.ok ? site.status.services : null
    return site.services ?? null
}

// One project's worst service decides how the whole site reads: a site whose web container is down is
// down, whatever its database is doing.
function stateOf(site: Project): 'up' | 'down' | 'stopped' {
    const services = servicesOf(site)
    if (!services || !services.length) return 'stopped'
    if (services.some(service => service.state === 'exited' || service.state === 'dead')) return 'down'
    if (services.some(service => service.state !== 'running')) return 'stopped'
    return 'up'
}

// Why a row cannot be taken at face value: an entry hostd could not parse, or one whose containers it
// could not read. Both keep their row, with the reason beside it.
function asideFor(site: Project): string | undefined {
    if (!site.valid) return site.reason ?? 'not registered properly'
    if (site.status && !site.status.ok) return site.status.message
    return undefined
}

const GIB = 1024 ** 3
const TIB = 1024 ** 4

// One unit for the pair, chosen by the total, so a figure reads as a single measurement rather than two
// unrelated ones.
function pair(used: number, total: number): string {
    const [unit, size] = total >= TIB ? (['TB', TIB] as const) : (['GB', GIB] as const)
    const show = (n: number) => {
        const value = n / size
        if (value >= 100) return value.toFixed(0)
        return value >= 10 ? value.toFixed(1) : value.toFixed(2)
    }
    return `${show(used)} / ${show(total)} ${unit}`
}

function share(used: number, total: number): number {
    return total > 0 ? Math.round((used / total) * 100) : 0
}

function toneFor(percent: number): 'good' | 'warn' | 'crit' {
    if (percent >= 90) return 'crit'
    if (percent >= 75) return 'warn'
    return 'good'
}

// gatherHome keeps health as unknown so every one of its effects stays injectable. The shape is hostd's
// Health, read from server/hostd/health.ts rather than guessed: system itself may be absent, and each of
// memory, cpu and disk inside it may be null with its reason in problems.
function healthOf(health: unknown): Health | null {
    return health && typeof health === 'object' ? (health as Health) : null
}

function Machine({ system }: { system: SystemUsage | null }) {
    if (!system) return <p className={styles.railNote}>The figures for this machine are {NOT_AVAILABLE}.</p>

    const meters = []
    const missing: { key: string, value: string, tone?: 'warn' }[] = []

    if (system.memory) {
        const { usedBytes, totalBytes } = system.memory
        const percent = share(usedBytes, totalBytes)
        meters.push(
            <Meter
                key="memory"
                label="Memory"
                value={pair(usedBytes, totalBytes)}
                percent={percent}
                tone={toneFor(percent)}
            />,
        )
    } else missing.push({ key: 'memory', value: NOT_AVAILABLE, tone: 'warn' })

    if (system.disk) {
        const { path, usedBytes, totalBytes } = system.disk
        const percent = share(usedBytes, totalBytes)
        meters.push(
            <Meter
                key="disk"
                label="Disk"
                value={pair(usedBytes, totalBytes)}
                percent={percent}
                tone={toneFor(percent)}
                threshold={90}
                note={percent >= 90 ? 'over the 90% line' : path}
                noteTone={percent >= 90 ? 'warn' : undefined}
            />,
        )
    } else missing.push({ key: 'disk', value: NOT_AVAILABLE, tone: 'warn' })

    if (!system.cpu) missing.push({ key: 'cpu', value: NOT_AVAILABLE, tone: 'warn' })
    else {
        const { cores, load1, load5, load15 } = system.cpu
        const loads = `load ${load1.toFixed(2)}, ${load5.toFixed(2)}, ${load15.toFixed(2)}`
        // cores is 0 when hostd could not count them. The three loads are still true and only their
        // denominator is missing, so the bar is what cannot be drawn, not the reading: it goes below as a
        // plain line instead of a meter whose fill would be a number nobody measured.
        if (cores > 0) {
            const percent = share(load1, cores)
            meters.push(
                <Meter
                    key="cpu"
                    label="CPU"
                    value={`${percent}%`}
                    percent={percent}
                    tone={toneFor(percent)}
                    note={`${loads} on ${cores} ${cores === 1 ? 'core' : 'cores'}`}
                />,
            )
        } else missing.push({ key: 'cpu', value: `${loads}, cores not counted`, tone: 'warn' })
    }

    const problems = system.problems ?? []

    return (
        <>
            {meters}
            {missing.length > 0 && <div className={styles.railGap}><KeyValue pairs={missing} /></div>}
            {problems.length > 0 && <p className={styles.railNote}>{problems.join('; ')}</p>}
        </>
    )
}

function Rail({ view }: { view: HomeView }) {
    if (view.kind === 'anonymous') return null

    // A client is told about their own site and nothing about the machine it happens to sit on. hostd
    // refuses them /health anyway, so there is nothing here to withhold, only nothing to ask for.
    if (view.kind === 'client') {
        const site = view.sites[0]
        return (
            <>
                <p className={styles.railHead}>your site</p>
                <KeyValue pairs={[
                    { key: 'site', value: site ? site.name ?? site.id : NOT_AVAILABLE },
                    { key: 'state', value: site ? stateOf(site) : NOT_AVAILABLE },
                    { key: 'looked after by', value: 'Horizons' },
                ]} />
            </>
        )
    }

    const health = healthOf(view.health)
    const warnings = health?.warnings ?? []
    const unreadable = Object.keys(health?.invalid ?? {}).length

    return (
        <>
            <p className={styles.railHead}>the machine</p>
            <Machine system={health?.system ?? null} />
            <section className={styles.railSec}>
                <KeyValue pairs={[
                    {
                        key: 'hostd',
                        value: view.trouble ? 'not answering' : 'answering',
                        tone: view.trouble ? 'warn' : undefined,
                    },
                    {
                        key: 'checks',
                        value: health
                            ? warnings.length ? `${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}` : 'all clear'
                            : NOT_AVAILABLE,
                        tone: health && warnings.length ? 'warn' : undefined,
                    },
                    ...(unreadable
                        ? [{ key: 'unreadable', value: `${unreadable} ${unreadable === 1 ? 'entry' : 'entries'}`, tone: 'warn' as const }]
                        : []),
                ]} />
            </section>
        </>
    )
}

export default async function PortalHome() {
    const view = await gatherHome({
        who: callerFromSession,
        config: () => {
            const problems: string[] = []
            const value = readHostd(process.env, problems)
            return problems.length ? { ok: false, problems } : { ok: true, value }
        },
        listProjects: (config, caller) => listProjects(config, caller),
        getHealth: (config, caller) => getHealth(config, caller),
    })

    if (view.kind === 'anonymous') redirect('/portal/sign-in')

    const isAdmin = view.kind === 'admin'
    const down = view.sites.filter(site => stateOf(site) === 'down')

    const nav = (
        <>
            <a className={styles.nav} href="/portal" aria-current="page">{isAdmin ? 'Dashboard' : 'Overview'}</a>
            <p className={styles.group}>{isAdmin ? 'sites' : 'your site'}</p>
            {/* Under /portal/sites/ rather than straight under /portal/: that segment has static siblings
                now, and a project whose id happened to be one of them would be unreachable. */}
            {view.sites.map(site => (
                <a className={styles.nav} key={site.id} href={`/portal/sites/${site.id}`}>
                    <StatusDot state={stateOf(site)} />
                    <span className={styles.navName}>{site.name ?? site.id}</span>
                </a>
            ))}
        </>
    )

    return (
        <Shell brand="Horizons" nav={nav} rail={<Rail view={view} />}>
            <div className={styles.hello}>
                <h1>{isAdmin ? 'Your sites' : 'Your site'}</h1>
                <p>
                    {down.length
                        ? `${down.length} ${down.length === 1 ? 'site is' : 'sites are'} down.`
                        : 'Everything is up.'}
                </p>
            </div>

            {view.trouble && (
                <Callout tone="warn" title="hostd did not answer">{view.trouble}</Callout>
            )}

            <StatStrip stats={[
                { key: 'sites', value: String(view.sites.length) },
                { key: 'down', value: String(down.length), tone: down.length ? 'crit' : undefined },
            ]} />

            <section className={styles.block}>
                <h2>{isAdmin ? 'Sites' : 'Your site'}</h2>
                {view.sites.length === 0
                    ? <p className={styles.empty}>
                        {view.trouble ? 'Nothing to show while hostd is unreachable.' : 'No sites yet.'}
                    </p>
                    : view.sites.map(site => (
                        <Row
                            key={site.id}
                            tone={stateOf(site) === 'down' ? 'crit' : undefined}
                            lead={<StatusDot state={stateOf(site)} />}
                            title={site.name ?? site.id}
                            sub={site.id}
                            aside={asideFor(site)}
                        />
                    ))}
            </section>
        </Shell>
    )
}
