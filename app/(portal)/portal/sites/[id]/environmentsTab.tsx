// The Environments tab: every environment the site has, and the chosen one's detail beside the list. The
// detail is three sections, each one a panel that used to be a tab or a table of its own: the Summary with
// copying and deleting (Settings), the Domains (the Domains tab) and the Env files (the Environment tab).
//
// A server component. Which environment is shown, and whether the add form is open, are part of the URL
// (?tab=environments&env=<name>, &add=1), so the list is plain links and the tab reloads and can be linked
// to, the same way the env file list works. The page has already checked the chosen name is one this site
// has, and read what the sections need.
//
// A client sees the list, the Summary without the port or any action, and the Domains as they have always
// seen them. The Env files, adding, deleting, restoring and copying are the operator's alone: hostd refuses
// a client every one of them, and none of them is drawn.

import type { Domain } from '@/server/hostd/domains'
import { LIVE, type EnvironmentName } from '@/server/hostd/env'
import type { Environment } from '@/server/hostd/projects'
import { Callout } from '@/ui/Callout/Callout'
import { shortCommit } from './deploys'
import { DomainsPanel } from './domainsPanel'
import { EnvPanel } from './env'
import { AddEnvironment, DeletedEnvironments, EnvironmentsSaid, EnvironmentSummary } from './environments'
import styles from './site.module.css'

// The fields of hostd's deleted-environment record the list reads
type Deleted = { environment: string, deletedAt: string, purgeAt: string, branch: string | null, domain: string | null }

type Props = {
    view: {
        id: string
        name: string
        capabilities: string[]
        environments: Environment[]
    }
    isAdmin: boolean
    // The environment shown, already checked against the site's own, with live the fallback
    selected: EnvironmentName
    // Whether the add form is open in place of the detail. Only ever drawn for the operator.
    adding: boolean
    // The env file open in the Env files section, from ?file
    file: string | null
    // Read by the page for the selected environment, and only when the domains capability is on
    domains: { domains: Domain[], trouble: string | null }
    // For the add form's branch select; null leaves a text field, and branchesError says why
    branches: string[] | null
    branchesError: string | null
    // For the operator's Deleted environments; null when the list could not be read
    deleted: Deleted[] | null
    deletedError: string | null
}

export function EnvironmentsTab({ view, isAdmin, selected, adding, file, domains, branches, branchesError, deleted, deletedError }: Props) {
    const base = `/portal/sites/${view.id}?tab=environments`
    const canDomains = view.capabilities.includes('domains')
    const canEnv = view.capabilities.includes('env')
    const addOpen = isAdmin && adding

    // live first, then the rest in the registry's own order
    const ordered = [
        ...view.environments.filter(one => one.name === LIVE),
        ...view.environments.filter(one => one.name !== LIVE),
    ]
    const shown = view.environments.find(one => one.name === selected) ?? null

    return (
        <EnvironmentsSaid>
            <div className={styles.envTab}>
                <div className={styles.envTabList}>
                    {ordered.length === 0
                        ? <p className={styles.empty}>The environments could not be read.</p>
                        : (
                            <nav aria-label="Environments">
                                <ul className={styles.envRows}>
                                    {ordered.map(environment => (
                                        <li key={environment.name}>
                                            <a
                                                className={styles.envRow}
                                                href={`${base}&env=${encodeURIComponent(environment.name)}`}
                                                aria-current={!addOpen && environment.name === selected ? 'page' : undefined}
                                            >
                                                <span className={styles.envRowName}>{environment.name}</span>
                                                <span className={styles.envRowMeta}>{environment.branch ?? 'no branch'}</span>
                                                <span className={styles.envRowMeta}>
                                                    {environment.deployed ? shortCommit(environment.deployed) : 'not deployed'}
                                                </span>
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </nav>
                        )}

                    {isAdmin && (
                        <>
                            <a
                                className={styles.envAdd}
                                href={`${base}&add=1`}
                                aria-current={addOpen ? 'page' : undefined}
                            >
                                Add environment
                            </a>
                            <DeletedEnvironments id={view.id} deleted={deleted} deletedError={deletedError} />
                        </>
                    )}
                </div>

                {/* Keyed on what it shows. Choosing another environment, or going back to live after a
                    delete, navigates on this same route, which rerenders rather than remounts, and the
                    sections below keep state in rows keyed by position (a domain's open confirm, its last
                    result, an env file being edited). None of it may carry over to the next one. */}
                <div className={styles.envTabDetail} key={addOpen ? 'add' : `env:${selected}`}>
                    {addOpen
                        ? <AddEnvironment
                            id={view.id}
                            taken={view.environments.map(one => one.name)}
                            branches={branches}
                            branchesError={branchesError}
                            primaryDomain={view.environments.find(one => one.name === LIVE)?.domain ?? null}
                        />
                        : (
                            <>
                                <h2 className={styles.envTabName}>{selected}</h2>

                                {shown
                                    ? <EnvironmentSummary id={view.id} siteName={view.name} isAdmin={isAdmin} environment={shown} />
                                    : (
                                        <section className={styles.block} aria-labelledby="summary">
                                            <h2 id="summary">Summary</h2>
                                            <p className={styles.empty}>This environment could not be read.</p>
                                        </section>
                                    )}

                                <section className={styles.envSection} aria-labelledby="domains">
                                    <h2 id="domains" className={styles.envSectionHead}>Domains</h2>
                                    {canDomains
                                        ? <DomainsPanel
                                            id={view.id}
                                            environment={selected}
                                            domains={domains.domains}
                                            isAdmin={isAdmin}
                                            projectName={view.name}
                                            trouble={domains.trouble}
                                        />
                                        : <Callout title="Not set up for this site">
                                            Domains are not switched on for this site yet. When they are, this is where
                                            its addresses are listed, with what each one is doing and what secures it.
                                        </Callout>}
                                </section>

                                {/* Not drawn for a client at all: hostd refuses them env outright */}
                                {isAdmin && (
                                    <section className={styles.envSection} aria-labelledby="env-files">
                                        <h2 id="env-files" className={styles.envSectionHead}>Env files</h2>
                                        {canEnv
                                            ? <EnvPanel id={view.id} file={file} environment={selected} />
                                            : <Callout title="Not switched on for this site">
                                                Environment files are not switched on for this site yet. Turn it on
                                                from this site&apos;s Settings tab.
                                            </Callout>}
                                    </section>
                                )}
                            </>
                        )}
                </div>
            </div>
        </EnvironmentsSaid>
    )
}
