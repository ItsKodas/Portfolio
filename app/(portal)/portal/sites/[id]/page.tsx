import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { getDb } from '@/server/db'
import { readHostd } from '@/server/hostd/config'
import { assertOwned, getProject, listProjects, type ServiceStatus } from '@/server/hostd/projects'
import { callerFromSession } from '@/server/hostd/session'
import { Callout } from '@/ui/Callout/Callout'
import { Row } from '@/ui/Row/Row'
import { Shell } from '@/ui/Shell/Shell'
import { StatStrip } from '@/ui/StatStrip/StatStrip'
import { StatusDot } from '@/ui/StatusDot/StatusDot'
import { EnvPanel } from './env'
import { Lifecycle } from './lifecycle'
import { SiteLogs } from './logs'
import { gatherSite } from './site'
import { SiteTabs } from './tabs'
import { stateOf, stateOfServices, type SiteState } from '../../siteState'
import nav from '../../portal.module.css'
import styles from './site.module.css'

export const metadata: Metadata = { title: 'Site' }
export const dynamic = 'force-dynamic'

// hostd exposes no list of a project's environments. The registry holds them (hostd/src/shared/registry.ts
// keeps an environments map per project) but the list handler answers id, name, capabilities, valid and a
// flat status, and a single project read answers services and nothing else. So there is exactly one
// environment a page can name today, and this is it. When hostd starts answering them, the Overview grows
// a second Environment panel beside the first rather than being rebuilt.
const LIVE = 'live'

// Designed, and hostd implements none of them. They are shown and marked rather than left out: a missing
// tab reads as a product that cannot do the thing, and a marked one reads as a product that will. In the
// client's language rather than the stack's, and with no date promised, because there is not one.
const WAITING: Record<string, { title: string, body: string }> = {
    deploys: {
        title: 'Not here yet',
        body: 'Deploys are designed and being built. When they arrive this is where you will see what '
            + 'changed, and roll back if it needs it.',
    },
    backups: {
        title: 'Not here yet',
        body: 'Your site is backed up, and this is where you will be able to see when it last happened '
            + 'and ask for a copy. The page comes after the deploys work.',
    },
    domains: {
        title: 'Not here yet',
        body: 'Domains and certificates are set up by hand today. This is where they will be listed, with '
            + 'what each one points at and when its certificate runs out.',
    },
}

// A reading hostd could not take is said to be missing, never shown as zero, for the same reason the
// dashboard says so: an unread figure and a figure that is genuinely nothing look identical once both are
// printed as 0, and only one of them is true.
const NOT_AVAILABLE = 'not available'

type TabId = 'overview' | 'logs' | 'env' | 'deploys' | 'backups' | 'domains'
type Tab = { id: TabId, label: string, disabled?: boolean }

// A search parameter arrives as a string, a list of them, or not at all. Only the first spelling is read:
// ?tab=logs&tab=env is somebody probing, not somebody navigating.
function one(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) return value[0] ?? null
    return value ?? null
}

// restartCount is explicitly null when hostd could not read it, which is not the same as a container that
// has never restarted. A total over a list where every reading is missing is not a total.
function restartsOf(services: ServiceStatus[]): string {
    const counted = services.map(service => service.restartCount).filter((count): count is number => count !== null)
    if (!counted.length) return NOT_AVAILABLE
    return String(counted.reduce((total, count) => total + count, 0))
}

// One environment's containers. Written as a component taking its own name and its own services, so the
// day hostd answers a project's environments the second one is another call to this and not a rewrite.
function Environment({ name, services, trouble }: { name: string, services: ServiceStatus[], trouble: string | null }) {
    return (
        <section className={styles.block}>
            <h2>{name}</h2>
            {services.length === 0
                ? <p className={styles.empty}>
                    {trouble ? 'Nothing to show while the containers cannot be read.' : 'Nothing is running.'}
                </p>
                : services.map(service => (
                    <Row
                        key={service.service}
                        tone={service.state === 'running' ? undefined : 'crit'}
                        title={<span className={styles.mono}>{service.service}</span>}
                        sub={service.health ? `${service.role}, ${service.health}` : service.role}
                        aside={service.state}
                        meta={service.image ?? undefined}
                    />
                ))}
        </section>
    )
}

type Props = {
    params: Promise<{ id: string }>
    searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function SitePage({ params, searchParams }: Props) {
    const { id } = await params
    const search = await searchParams

    const view = await gatherSite({
        who: callerFromSession,
        config: () => {
            const problems: string[] = []
            const value = readHostd(process.env, problems)
            return problems.length ? { ok: false, problems } : { ok: true, value }
        },
        listProjects: (config, caller) => listProjects(config, caller),
        getProject: (config, caller, project) => getProject(config, caller, project),
        // getDb() is reached for here rather than at the top of the file, so the operator, who owns every
        // project and is never asked this, never touches the database to read a page.
        owns: (clientId, projectId) => assertOwned(clientId, projectId, async project => {
            const db = getDb()
            return db.site.findUnique({ where: { projectId: project }, select: { projectId: true, clientId: true } })
        }),
    }, id)

    if (view.kind === 'anonymous') redirect('/portal/sign-in')

    // Both of these are notFound(), and that is the point. Answering "no such site" to a client asking
    // about somebody else's project confirms it does not exist; answering "not yours" confirms it does.
    // Neither answer is ours to give, so they are the same answer.
    if (view.kind === 'forbidden' || view.kind === 'missing') notFound()

    const tabs: Tab[] = [
        { id: 'overview', label: 'Overview' },
        { id: 'logs', label: 'Logs' },
        // Editing env files is the operator's alone: hostd refuses a client outright, ahead of ownership,
        // so for a client the tab is absent rather than shown and refused.
        ...(view.isAdmin ? [{ id: 'env' as const, label: 'Environment' }] : []),
        { id: 'deploys', label: 'Deploys', disabled: true },
        { id: 'backups', label: 'Backups', disabled: true },
        // Absent for a client rather than disabled, for the same reason Environment is: domains will be
        // the operator's to set, so promising a client a tab they will never be given is a worse lie than
        // not showing it.
        ...(view.isAdmin ? [{ id: 'domains' as const, label: 'Domains', disabled: true }] : []),
    ]

    // Checked against the tabs this viewer actually has, not merely against the list of names, so ?tab=env
    // in a client's address bar lands on Overview rather than on a panel they may not have.
    const wanted = one(search.tab)
    const selected = tabs.some(tab => tab.id === wanted) ? wanted as TabId : 'overview'

    // What this one site is doing, taken from the single project read rather than from the listing. The
    // listing is one call for every site and can come back with nothing to say about any of them; this
    // page asked hostd about this project on its own as well, and that answer is the better one.
    const current: SiteState = view.trouble ? 'unknown' : stateOfServices(view.services)

    const navigation = (
        <>
            <a className={nav.nav} href="/portal">{view.isAdmin ? 'Dashboard' : 'Overview'}</a>
            <p className={nav.group}>{view.isAdmin ? 'sites' : 'your site'}</p>
            {view.sites.map(site => (
                <a
                    className={nav.nav}
                    key={site.id}
                    href={`/portal/sites/${site.id}`}
                    aria-current={site.id === view.id ? 'page' : undefined}
                >
                    <StatusDot state={site.id === view.id ? current : stateOf(site)} />
                    <span className={nav.navName}>{site.name ?? site.id}</span>
                </a>
            ))}
        </>
    )

    return (
        <Shell brand="Horizons" nav={navigation} rail={null} fill>
            <div className={styles.hello}>
                <h1>{view.name}</h1>
                <p className={styles.mono}>{view.id}</p>
            </div>

            {view.trouble && (
                <Callout tone="warn" title="The containers could not be read">{view.trouble}</Callout>
            )}

            <SiteTabs
                tabs={tabs}
                selected={selected}
                basePath={`/portal/sites/${view.id}`}
                label={`${view.name} tools`}
            />

            <div
                className={styles.panel}
                role="tabpanel"
                id={`panel-${selected}`}
                aria-labelledby={`tab-${selected}`}
                tabIndex={0}
            >
                {selected === 'overview' && (
                    <>
                        <div className={styles.strip}>
                            <StatStrip stats={[
                                { key: 'state', value: current, tone: current === 'down' ? 'crit' : undefined },
                                // Nothing was read, so nothing is counted: a zero here would be a figure
                                // this page was never given, printed as though it had been.
                                { key: 'services', value: view.trouble ? NOT_AVAILABLE : String(view.services.length) },
                                { key: 'restarts', value: view.trouble ? NOT_AVAILABLE : restartsOf(view.services) },
                            ]} />
                        </div>
                        <Lifecycle id={view.id} enabled={view.capabilities.includes('lifecycle')} />
                        <Environment name={LIVE} services={view.services} trouble={view.trouble} />
                    </>
                )}

                {selected === 'logs' && <SiteLogs id={view.id} services={view.services.map(service => service.service)} />}

                {selected === 'env' && <EnvPanel id={view.id} file={one(search.file)} />}

                {WAITING[selected] && (
                    <Callout title={WAITING[selected].title}>{WAITING[selected].body}</Callout>
                )}
            </div>
        </Shell>
    )
}
