import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { getDb } from '@/server/db'
import { listBranches } from '@/server/hostd/branches'
import { readHostd } from '@/server/hostd/config'
import { listCredentials } from '@/server/hostd/credentials'
import { listDomains, type Domain } from '@/server/hostd/domains'
import type { EnvironmentName } from '@/server/hostd/env'
import { forAdmin, forClient } from '@/server/hostd/errors'
import { assertOwned, getProject, listProjects, type ServiceStatus } from '@/server/hostd/projects'
import { callerFromSession } from '@/server/hostd/session'
import { Callout } from '@/ui/Callout/Callout'
import { Shell } from '@/ui/Shell/Shell'
import { StatusDot } from '@/ui/StatusDot/StatusDot'
import { DeployPanel } from './deployPanel'
import { DomainsPanel } from './domainsPanel'
import { EnvPanel } from './env'
import { Lifecycle } from './lifecycle'
import { SiteLogs } from './logs'
import { SiteDot, SiteStats } from './reading'
import { SiteSettingsForm } from './settings'
import { SettlingProvider } from './settling'
import { gatherSite } from './site'
import { SiteTabs } from './tabs'
import { NewSiteButton } from '../../newSite/NewSite'
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

// What stands in for a tab with nothing behind it. A tab is shown and marked rather than left out: a
// missing tab reads as a product that cannot do the thing, and a marked one reads as a product that will.
// In the client's language rather than the stack's, and with no date promised, because there is not one.
//
// Backups is the only entry left that means what this record originally meant, which is that nothing is
// built. Deploys has a real panel and keeps an entry here for the other sentence: the tab works, and
// hostd would refuse this one site. Domains says that same second sentence beside its own panel instead,
// rather than through a record whose name says the feature is still coming.
const WAITING: Record<string, { title: string, body: string }> = {
    // Shown only when this project has no deploy capability: the tab itself works, and hostd refusing
    // the whole thing for this site is a different sentence from the one below.
    deploys: {
        title: 'Not set up for this site',
        body: 'Deploys are not switched on for this site yet. When they are, this is where you will see '
            + 'what changed, and be able to put the last version back.',
    },
    // Shown only when this project has no env capability: without it hostd refuses env outright, which
    // read as broken rather than as off before this tab was disabled for it.
    env: {
        title: 'Not switched on for this site',
        body: 'Environment files are not switched on for this site yet. Turn it on from this site\'s '
            + 'Settings tab.',
    },
    backups: {
        title: 'Not here yet',
        body: 'Your site is backed up, and this is where you will be able to see when it last happened '
            + 'and ask for a copy. The page comes after the deploys work.',
    },
}

// A reading hostd could not take is said to be missing, never shown as zero, for the same reason the
// dashboard says so: an unread figure and a figure that is genuinely nothing look identical once both are
// printed as 0, and only one of them is true.
const NOT_AVAILABLE = 'not available'

type TabId = 'overview' | 'logs' | 'env' | 'deploys' | 'backups' | 'domains' | 'settings'
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

// The Domains tab's own read. DeployPanel asks hostd itself while it renders; DomainsPanel cannot,
// because the operator's table and the client's sentences are two screens over one list and both are
// worth rendering without a network in the way, so it takes the list as a prop and the asking happens
// here. Only when that tab is open: every other tab would be paying for a round trip nobody is looking at.
//
// The caller is re-derived from the session rather than taken from the page's own view, the same way
// env.tsx and deployPanel.tsx do it, so nothing the browser sent decides who hostd is asked as.
async function readDomains(
    id: string,
    environment: EnvironmentName,
    isAdmin: boolean,
): Promise<{ domains: Domain[], trouble: string | null }> {
    const who = await callerFromSession()
    if (!who) return { domains: [], trouble: forClient('unavailable') }

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    // The operator is told which setting; a client is told nothing about our infrastructure
    if (problems.length) return { domains: [], trouble: isAdmin ? problems.join('; ') : forClient('unavailable') }

    const result = await listDomains(config, who.caller, id, environment)
    if (!result.ok) {
        return { domains: [], trouble: isAdmin ? forAdmin(result.code, result.message) : forClient(result.code) }
    }
    return { domains: result.value, trouble: null }
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
    // The same rule for domains: without the capability hostd refuses the listing too, so the tab is
    // marked rather than opened onto a refusal.
    const canDomains = view.capabilities.includes('domains')
    // hostd refuses env outright without this capability, which is why the tab is disabled rather than
    // simply hidden: it is the operator's own doing to switch on, from the Settings tab below.
    const canEnv = view.capabilities.includes('env')

    const tabs: Tab[] = [
        { id: 'overview', label: 'Overview' },
        { id: 'logs', label: 'Logs' },
        // Editing env files is the operator's alone: hostd refuses a client outright, ahead of ownership,
        // so for a client the tab is absent rather than shown and refused. Disabled rather than absent for
        // the operator until the project has the capability, the same as Deploys below.
        ...(view.isAdmin ? [{ id: 'env' as const, label: 'Environment', disabled: !canEnv }] : []),
        // A client may read their own site's deploys: hostd's 'deploy-read' is not among its admin-only
        // verbs, so this tab is theirs too, showing what reached their site rather than every build.
        // Both roles need the project to have the capability at all, which is what disables it.
        { id: 'deploys', label: 'Deploys', disabled: !canDeploy },
        { id: 'backups', label: 'Backups', disabled: true },
        // This was absent for a client, on the reasoning that domains would only ever be the operator's
        // to set and that promising a tab nobody would be given is the worse lie. That was right for a
        // tab with no read side. It is not right now: hostd leaves 'domains-read' out of its admin-only
        // verbs, so a client may read their own site's addresses and be told whether each one works.
        // Acting on them is still the operator's alone, which the panel decides, not this list.
        { id: 'domains', label: 'Domains', disabled: !canDomains },
        // What a site is allowed to do is the operator's alone to see or change, the same as Environment:
        // absent for a client rather than disabled. Last in the list because it is where the switches for
        // the tabs above it live, so it reads as the thing behind them rather than one more of them.
        ...(view.isAdmin ? [{ id: 'settings' as const, label: 'Settings' }] : []),
    ]

    // Checked against the tabs this viewer actually has, not merely against the list of names, so ?tab=env
    // in a client's address bar lands on Overview rather than on a panel they may not have.
    const wanted = one(search.tab)
    const selected = tabs.some(tab => tab.id === wanted) ? wanted as TabId : 'overview'

    // Which environment the Deploys and Domains tabs are about. Both are per environment: a deploy runs
    // against one, and a hostname belongs to one. Checked against the ones this project actually has,
    // so ?env=test on a project that has only live lands on live rather than asking hostd about an
    // environment that is not there. Falls back to live when the listing could not be read at all: the
    // panel then asks and reports hostd's own refusal, which is better than not asking.
    const names = view.environments.map(environment => environment.name)
    const askedFor = one(search.env)
    const environment = names.find(name => name === askedFor) ?? names[0] ?? LIVE

    // Asked for only when that tab is the one open, and only when hostd would answer it at all
    const domains = selected === 'domains' && canDomains
        ? await readDomains(view.id, environment, view.isAdmin)
        : { domains: [], trouble: null }

    // What this one site is doing, taken from the single project read rather than from the listing. The
    // listing is one call for every site and can come back with nothing to say about any of them; this
    // page asked hostd about this project on its own as well, and that answer is the better one.
    const current: SiteState = view.trouble ? 'unknown' : stateOfServices(view.services)

    // Fetched only for the Settings tab, which is the only place either is used, and only once the
    // registry entry itself is known to be readable: the form is not drawn otherwise, so there is nothing
    // for a branch list to fill in. Read for the repo as it stands saved in the registry, hostd's own
    // answer to git ls-remote --heads, so this is the state of the remote right now rather than whatever
    // was last cloned. Failure here is ordinary, not exceptional (no repo, an unreachable one, hostd
    // itself down): branches stays null, branchesError carries hostd's own words, and the form below still
    // renders with a plain text field, exactly as it does when a container read fails elsewhere on this
    // page. A save must never be blocked by a list that did not load.
    let branches: string[] | null = null
    let branchesError: string | null = null
    // The credential list, fetched alongside branches from the same caller and config: both are read only
    // for the Settings tab, and there is exactly one hostd config and one session caller to read either
    // with, so reading either twice would only be two chances for the two reads to disagree.
    let credentials: string[] | null = null
    let credentialsError: string | null = null
    if (view.isAdmin && selected === 'settings' && view.registryEntry === 'valid') {
        const problems: string[] = []
        const hostdConfig = readHostd(process.env, problems)
        const who = problems.length === 0 ? await callerFromSession() : null
        if (problems.length > 0) {
            branchesError = problems.join('; ')
            credentialsError = problems.join('; ')
        } else if (!who) {
            branchesError = 'hostd could not be reached.'
            credentialsError = 'hostd could not be reached.'
        } else {
            const result = await listBranches(hostdConfig, who.caller, view.id)
            if (result.ok) branches = result.value
            else branchesError = result.message

            const held = await listCredentials(hostdConfig, who.caller)
            if (held.ok) credentials = held.value
            else credentialsError = held.message
        }
    }

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
                    {/* This site's own dot is the one that moves while the controls below are being
                        used, so it is the one that says what is being done to it. */}
                    {site.id === view.id
                        ? <SiteDot state={current} />
                        : <StatusDot state={stateOf(site)} bare />}
                    <span className={nav.navName}>{site.name ?? site.id}</span>
                </a>
            ))}
            {view.isAdmin && <NewSiteButton />}
        </>
    )

    return (
        // Around the whole shell rather than around the panel: the sidebar draws this site's dot too, and
        // a restart that calms the strip and leaves a red dot beside the name has only moved the alarm.
        <SettlingProvider state={current}>
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
                                <SiteStats
                                    state={current}
                                    // Nothing was read, so nothing is counted: a zero here would be a figure
                                    // this page was never given, printed as though it had been.
                                    services={view.trouble ? NOT_AVAILABLE : String(view.services.length)}
                                    restarts={view.trouble ? NOT_AVAILABLE : restartsOf(view.services)}
                                />
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

                    {selected === 'env' && canEnv && <EnvPanel id={view.id} file={one(search.file)} />}

                    {selected === 'deploys' && canDeploy && (
                        <DeployPanel
                            id={view.id}
                            environments={view.environments}
                            environment={environment}
                            enabled={canDeploy}
                        />
                    )}

                    {selected === 'domains' && (canDomains
                        ? <DomainsPanel
                            id={view.id}
                            environments={view.environments}
                            environment={environment}
                            domains={domains.domains}
                            isAdmin={view.isAdmin}
                            projectName={view.name}
                            trouble={domains.trouble}
                        />
                        // Said here rather than from WAITING, which is for a tab with nothing behind it at
                        // all. This tab has a panel; it is this one site hostd would refuse.
                        : <Callout title="Not set up for this site">
                            Domains are not switched on for this site yet. When they are, this is where its
                            addresses are listed, with what each one is doing and what secures it.
                        </Callout>)}

                    {/* Never drawn over capabilities that were not actually read: an 'unread' or 'invalid'
                        registry entry says why instead, with no form and no Save, rather than showing eight
                        unticked boxes over a site that may have every one of them on. */}
                    {selected === 'settings' && (
                        view.registryEntry === 'valid'
                            ? (
                                <SiteSettingsForm
                                    id={view.id}
                                    capabilities={view.capabilities}
                                    repo={view.repo}
                                    credential={view.credential}
                                    environments={view.environments}
                                    branches={branches}
                                    branchesError={branchesError}
                                    credentials={credentials}
                                    credentialsError={credentialsError}
                                />
                            )
                            : (
                                <Callout tone="warn" title="Settings are not available">
                                    {view.registryEntry === 'invalid'
                                        ? view.reason ?? 'hostd could not parse this site\'s registry entry.'
                                        : view.trouble ?? 'hostd could not be reached.'}
                                </Callout>
                            )
                    )}

                    {/* Only when the tab is disabled: deploys and env have panels now, and this is what
                        stands in for a project hostd would refuse either verb for. */}
                    {WAITING[selected] && !(selected === 'deploys' && canDeploy) && !(selected === 'env' && canEnv) && (
                        <Callout title={WAITING[selected].title}>{WAITING[selected].body}</Callout>
                    )}
                    </div>
            </Shell>
        </SettlingProvider>
    )
}
