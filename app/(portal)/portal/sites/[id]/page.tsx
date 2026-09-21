import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { getDb } from '@/server/db'
import { readHostd } from '@/server/hostd/config'
import { assertOwned, getProject, listProjects, type ServiceStatus } from '@/server/hostd/projects'
import { callerFromSession } from '@/server/hostd/session'
import { Callout } from '@/ui/Callout/Callout'
import { Shell } from '@/ui/Shell/Shell'
import { StatStrip } from '@/ui/StatStrip/StatStrip'
import { StatusDot } from '@/ui/StatusDot/StatusDot'
import { DeployPanel } from './deployPanel'
import { EnvPanel } from './env'
import { Lifecycle } from './lifecycle'
import { SiteLogs } from './logs'
import { gatherSite } from './site'
import { SiteTabs } from './tabs'
import { serviceDot, stateOf, stateOfServices, type SiteState } from '../../siteState'
import nav from '../../portal.module.css'
import styles from './site.module.css'

export const metadata: Metadata = { title: 'Site' }
export const dynamic = 'force-dynamic'

// hostd now answers a project's environments on every listing (hostd/src/api/routes.ts, environmentsFor),
// and the Deploys tab below uses them. The Overview's Environment panel still says live and only live: a
// status read answers the project's containers, not one environment's, so there is nothing yet to put in
// a second panel. That one waits for hostd to report services per environment.
const LIVE = 'live'

// Designed, and hostd implements none of them. They are shown and marked rather than left out: a missing
// tab reads as a product that cannot do the thing, and a marked one reads as a product that will. In the
// client's language rather than the stack's, and with no date promised, because there is not one.
const WAITING: Record<string, { title: string, body: string }> = {
    // Shown only when this project has no deploy capability: the tab itself works, and hostd refusing
    // the whole thing for this site is a different sentence from the two below.
    deploys: {
        title: 'Not set up for this site',
        body: 'Deploys are not switched on for this site yet. When they are, this is where you will see '
            + 'what changed, and be able to put the last version back.',
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

// One environment's containers, as a slim bar beside the log rather than a block under it: it is a
// dozen words that change once a day, and the log is the thing being read. Written as a component taking
// its own name and its own services, so the day hostd answers a project's environments the second one is
// another call to this and not a rewrite.
function Environment({ name, services, trouble }: { name: string, services: ServiceStatus[], trouble: string | null }) {
    return (
        <aside className={styles.env}>
            <h2 className={styles.envName}>{name}</h2>
            {services.length === 0
                ? <p className={styles.empty}>
                    {trouble ? 'Nothing to show while the containers cannot be read.' : 'Nothing is running.'}
                </p>
                : <ul className={styles.envList}>
                    {services.map(service => (
                        <li className={styles.envItem} key={service.service}>
                            <span className={styles.envService}>{service.service}</span>
                            {/* Docker's own word for the container, over the dot that stands for it:
                                "exited" and "dead" are both a red dot and are not the same news. */}
                            <StatusDot state={serviceDot(service.state)} label={service.state} />
                            <span className={styles.envMeta}>
                                {service.health ? `${service.role}, ${service.health}` : service.role}
                            </span>
                            {service.image && <span className={styles.envImage}>{service.image}</span>}
                        </li>
                    ))}
                </ul>}
        </aside>
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

    // hostd needs the project to carry the deploy capability for any of it, reading the history included
    const canDeploy = view.capabilities.includes('deploy')

    const tabs: Tab[] = [
        { id: 'overview', label: 'Overview' },
        { id: 'logs', label: 'Logs' },
        // Editing env files is the operator's alone: hostd refuses a client outright, ahead of ownership,
        // so for a client the tab is absent rather than shown and refused.
        ...(view.isAdmin ? [{ id: 'env' as const, label: 'Environment' }] : []),
        // A client may read their own site's deploys: hostd's 'deploy-read' is not among its admin-only
        // verbs, so this tab is theirs too, showing what reached their site rather than every build.
        // Both roles need the project to have the capability at all, which is what disables it.
        { id: 'deploys', label: 'Deploys', disabled: !canDeploy },
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

    // Which environment the Deploys tab is about. Checked against the ones this project actually has,
    // so ?env=test on a project that has only live lands on live rather than asking hostd about an
    // environment that is not there. Falls back to live when the listing could not be read at all: the
    // panel then asks and reports hostd's own refusal, which is better than not asking.
    const names = view.environments.map(environment => environment.name)
    const askedFor = one(search.env)
    const environment = names.find(name => name === askedFor) ?? names[0] ?? LIVE

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
                    <StatusDot state={site.id === view.id ? current : stateOf(site)} bare />
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

                        <Lifecycle id={view.id} enabled={view.capabilities.includes('lifecycle')} state={current} />

                        {/* What the site is doing right now, which is the log, with what it is made of
                            beside it. The Logs tab is the same view given the whole panel, for when the
                            thing being read is longer than a glance. */}
                        <div className={styles.split}>
                            <div className={styles.splitMain}>
                                <SiteLogs id={view.id} services={view.services.map(service => service.service)} />
                            </div>
                            <Environment name={LIVE} services={view.services} trouble={view.trouble} />
                        </div>
                    </>
                )}

                {selected === 'logs' && <SiteLogs id={view.id} services={view.services.map(service => service.service)} />}

                {selected === 'env' && <EnvPanel id={view.id} file={one(search.file)} />}

                {selected === 'deploys' && canDeploy && (
                    <DeployPanel
                        id={view.id}
                        environments={view.environments}
                        environment={environment}
                        enabled={canDeploy}
                    />
                )}

                {/* Only when the tab is disabled: deploys has a panel now, and this is what stands in
                    for a project hostd would refuse it for. */}
                {WAITING[selected] && !(selected === 'deploys' && canDeploy) && (
                    <Callout title={WAITING[selected].title}>{WAITING[selected].body}</Callout>
                )}
            </div>
        </Shell>
    )
}
