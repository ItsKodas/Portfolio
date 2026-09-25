'use client'

// The registry entry itself: which capabilities the project has, its repo, and each environment's
// branch. This is the only form on the site page that changes the registry rather than asking hostd to
// act on what is already in it, which is why it is admin only end to end (actions.ts's allow(id, true),
// the same gate saveEnvAction uses). Beside it, live's primary domain, set and changed through the same
// actions and confirmation the Domains tab used, and deleting the site.

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { LIVE } from '@/server/hostd/environmentName'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { CAPABILITIES, NOT_BUILT, SWITCHES, type SwitchKey } from '../features'
import { deleteSiteAction, saveSettingsAction, type SiteActionResult } from './actions'
import { PrimaryDomain } from './domainControls'
import { PortControl } from './portControl'
import styles from './site.module.css'

// A deploy checks nothing before it is asked to run, because there is nothing here to check it with: it
// needs a git repository already at the environment's dir, and hostd only finds that out when it runs.
const CANNOT_CHECK = 'A deploy needs a git repository already at the environment\'s dir (dir/.git). hostd '
    + 'only finds that out when it runs. This form cannot check that ahead of it.'

export function SiteSettingsForm({ id, name, capabilities, repo, credential, environments, branches = null, branchesError = null, credentials = null, credentialsError = null }: {
    id: string
    // The site's name, which hostd wants typed back to delete it
    name: string
    capabilities: string[]
    repo: string | null
    credential: string | null
    // domain is live's primary domain for the Primary domain section, null when it has none
    environments: Array<{ name: string, branch: string | null, domain?: string | null, websockets?: boolean, flexibleSsl?: boolean, dir?: string, port?: number }>
    // The repository's branches, fetched for the repo as it stands saved, not for whatever is currently
    // typed into the Repo field above: editing that field without saving leaves this offering the old
    // repo's branches, which is the one thing left as it is rather than fixed, because re-fetching on
    // every keystroke would be worse. null when there is no list to offer, whether that is no repo, an
    // unreachable one, or hostd itself being unreachable; branchesError says which in hostd's own words.
    branches?: string[] | null
    branchesError?: string | null
    // The credential names hostd holds, or null when there is no list to offer (hostd unreachable, or
    // the fetcher down). credentialsError says which, in hostd's own words.
    credentials?: string[] | null
    credentialsError?: string | null
}) {
    const router = useRouter()
    const [checked, setChecked] = useState(() => new Set(capabilities))
    const [repoValue, setRepoValue] = useState(repo ?? '')
    const [credentialValue, setCredentialValue] = useState(credential ?? '')
    const [branchValues, setBranchValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(environments.map(env => [env.name, env.branch ?? ''])))
    // Keyed by switch then environment. Absent in props means off, which is what hostd means by it too.
    const [switchValues, setSwitchValues] = useState<Record<SwitchKey, Record<string, boolean>>>(() => ({
        websockets: Object.fromEntries(environments.map(env => [env.name, env.websockets ?? false])),
        flexibleSsl: Object.fromEntries(environments.map(env => [env.name, env.flexibleSsl ?? false])),
    }))
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    // Set instead of said on a no-op save: said is what a call to hostd came back with, and a save that
    // made no call has nothing of hostd's to report.
    const [nothingChanged, setNothingChanged] = useState(false)

    function toggle(key: string) {
        setChecked(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    async function save() {
        setSaid(null)
        setNothingChanged(false)

        // The registry's own order first, then anything newly ticked: a hand-maintained [logs, lifecycle]
        // comes back as it was written rather than sorted into this file's order. The first list also
        // keeps any capability the registry holds that CAPABILITIES below does not know about (hostd owns
        // that list, not this page): it has no checkbox, so it can never be unticked here, and dropping it
        // silently on the first save of any site is not something the day hostd gains a ninth capability
        // should cost.
        const nextCapabilities = [
            ...capabilities.filter(key => checked.has(key)),
            ...CAPABILITIES.filter(cap => checked.has(cap.key) && !capabilities.includes(cap.key)).map(cap => cap.key),
        ]
        const nextRepo = repoValue.trim() === '' ? null : repoValue
        const nextCredential = credentialValue.trim() === '' ? null : credentialValue
        // Compared per environment, not as one object: a save that only touched live must never carry
        // test's branch along, because a present key means "set this" to hostd and an untouched one taken
        // from stale props would set it back to whatever this page happened to be rendered from. That is
        // exactly how a repo got wiped from a live site: a page that read a stale registry copy sent every
        // field back, including one the operator had never touched this session.
        const changedBranches: Record<string, string | null> = {}
        for (const env of environments) {
            // An environment missing from local state arrived after this form was drawn (an add or a
            // restore refreshes the page and keeps this state), so it is untouched, not cleared.
            const nextBranch = blankToNull(ownValue(branchValues, env.name) ?? env.branch ?? '')
            if (nextBranch !== (env.branch ?? null)) changedBranches[env.name] = nextBranch
        }
        const payload: {
            capabilities?: string[]
            repo?: string | null
            credential?: string | null
            branches?: Record<string, string | null>
            websockets?: Record<string, boolean>
            flexibleSsl?: Record<string, boolean>
        } = {}
        if (!sameList(nextCapabilities, capabilities)) payload.capabilities = nextCapabilities
        if (nextRepo !== repo) payload.repo = nextRepo
        if (nextCredential !== credential) payload.credential = nextCredential
        if (Object.keys(changedBranches).length > 0) payload.branches = changedBranches
        // Per environment for the same reason as branches: flipping a switch rewrites a vhost, so an
        // environment nobody touched must not be sent at all.
        for (const { key } of SWITCHES) {
            const changed: Record<string, boolean> = {}
            for (const env of environments) {
                const next = ownValue(switchValues[key], env.name) ?? env[key] ?? false
                if (next !== (env[key] ?? false)) changed[env.name] = next
            }
            if (Object.keys(changed).length > 0) payload[key] = changed
        }

        if (Object.keys(payload).length === 0) {
            setNothingChanged(true)
            return
        }

        setPending(true)
        try {
            const result = await saveSettingsAction(id, payload)
            setSaid(result)
            // Capabilities gate which tabs this page shows, so a save that changed them leaves the page
            // showing the wrong set until it is re-read.
            if (result.ok) router.refresh()
        } catch {
            setSaid({ ok: false, error: 'That did not work. Try reloading the page.' })
        } finally {
            setPending(false)
        }
    }

    const notHeld = credentials !== null && credentialValue !== '' && !credentials.includes(credentialValue)

    return (
        <div className={styles.settings}>
            <fieldset className={styles.capabilities}>
                <legend>Capabilities</legend>
                {CAPABILITIES.map(cap => (
                    <label
                        key={cap.key}
                        className={[styles.capability, !cap.built && styles.capabilityOff].filter(Boolean).join(' ')}
                    >
                        <input type="checkbox" checked={checked.has(cap.key)} onChange={() => toggle(cap.key)} />
                        {cap.key}
                    </label>
                ))}
            </fieldset>
            <p className={styles.note}>{NOT_BUILT}</p>

            <Field label="Repo" value={repoValue} onChange={event => setRepoValue(event.target.value)} />
            <p className={styles.note}>{CANNOT_CHECK}</p>

            {credentials ? (
                <Field
                    as="select"
                    label="Account"
                    value={credentialValue}
                    onChange={event => setCredentialValue(event.target.value)}
                >
                    {/* The default token, and the way back to it. */}
                    <option value="">default (GITHUB_TOKEN)</option>
                    {credentials.map(name => <option key={name} value={name}>{name}</option>)}
                    {/* A saved name the fetcher no longer holds, kept for the same reason the branch
                        select keeps an unknown branch: swapping it for something on the list would be
                        this page rewriting the operator's configuration by rendering. */}
                    {notHeld && <option value={credentialValue}>{credentialValue}</option>}
                </Field>
            ) : (
                <Field label="Account" value={credentialValue} onChange={event => setCredentialValue(event.target.value)} />
            )}
            {notHeld && (
                <p className={styles.note}>
                    {`There is no credential named "${credentialValue}" on the host, so anything that reaches GitHub for this site will fail until one is added to .env.fetcher or another is chosen here.`}
                </p>
            )}
            {credentialsError && <p className={styles.note}>{`The host's credential names could not be read: ${credentialsError}`}</p>}

            {environments.map(env => {
                const branchValue = ownValue(branchValues, env.name) ?? env.branch ?? ''
                // The saved value can be a branch the repository does not have, exactly as `main` was on
                // the live incident this change is for: an operator typed it into what looked like a text
                // box, and nothing checked it against the repository before it went into the registry. A
                // select must still show it rather than falling back to whatever option happens to be
                // first, or the page would be lying about what is actually saved.
                const onRepo = branches !== null && branchValue !== '' && branches.includes(branchValue)
                const notOnRepo = branches !== null && branchValue !== '' && !onRepo

                return (
                    <div key={env.name} className={styles.envSettings}>
                        <p className={styles.envName}>{env.name}</p>
                        {env.dir && <p className={styles.mono}>{env.dir}</p>}
                        {env.port !== undefined && <PortControl id={id} environment={env.name} port={env.port} />}
                        {branches ? (
                            // A <select>, not the <input list> this used to be: a datalist only offers its
                            // options once the operator starts typing, so it read as a plain text field
                            // rather than a dropdown, and that is exactly how a hand typed `main` reached
                            // the registry of a repository with no branch by that name. A select cannot be
                            // typed past.
                            <Field
                                as="select"
                                label={`${env.name} branch`}
                                value={branchValue}
                                onChange={event => setBranchValues(prev => ({ ...prev, [env.name]: event.target.value }))}
                            >
                                {/* How an environment stops deploying, so there has to be a way back here. */}
                                <option value="">No branch</option>
                                {branches.map(name => <option key={name} value={name}>{name}</option>)}
                                {/* The saved branch, kept even though it is not one of the options above: dropping it
                                    or swapping it for something on the list would be this page rewriting the
                                    operator's configuration by rendering a page. */}
                                {notOnRepo && <option value={branchValue}>{branchValue}</option>}
                            </Field>
                        ) : (
                            <Field
                                label={`${env.name} branch`}
                                value={branchValue}
                                onChange={event => setBranchValues(prev => ({ ...prev, [env.name]: event.target.value }))}
                            />
                        )}
                        {notOnRepo && (
                            <p className={styles.note}>
                                {`"${branchValue}" is not one of this repository's branches, so the next deploy on ${env.name} will fail until this is changed.`}
                            </p>
                        )}
                        {SWITCHES.map(({ key, label, note }) => (
                            <div key={key}>
                                <label className={styles.capability}>
                                    <input
                                        type="checkbox"
                                        checked={ownValue(switchValues[key], env.name) ?? env[key] ?? false}
                                        onChange={event => {
                                            const enabled = event.target.checked
                                            setSwitchValues(prev => ({ ...prev, [key]: { ...prev[key], [env.name]: enabled } }))
                                        }}
                                    />
                                    {`${env.name} ${label}`}
                                </label>
                                <p className={styles.note}>{note}</p>
                            </div>
                        ))}
                    </div>
                )
            })}
            {/* Never blocks the field and never reads as a validation error: hostd could not read the
                list, not the operator did anything wrong. One line for both environments' fields, since
                they share the one list. */}
            {branchesError && <p className={styles.note}>{`The repository's branches could not be read: ${branchesError}`}</p>}

            <div className={styles.save}>
                <Button variant="primary" disabled={pending} onClick={save}>
                    {pending ? 'Saving...' : 'Save'}
                </Button>
            </div>

            {said && (
                <div className={styles.save}>
                    {said.ok
                        ? <Callout title="Saved">{said.message}</Callout>
                        : <Callout tone="crit" title="That was not saved">{said.error}</Callout>}
                </div>
            )}

            {nothingChanged && <p className={styles.note}>Nothing changed, so nothing was saved.</p>}

            <LivePrimaryDomain id={id} live={environments.find(env => env.name === LIVE) ?? null} />

            <DeleteSite id={id} name={name} />
        </div>
    )
}

// live's main address. Keyed on it, so a change made elsewhere and read back on a refresh starts the
// control over rather than leaving a half typed address or an open confirm about the old one. What the
// last set or change said is held here, outside the key: the refresh after this control's own success
// brings the new address too, and that message (for a set, the only word on adopting) has to survive it.
function LivePrimaryDomain({ id, live }: { id: string, live: { domain?: string | null } | null }) {
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    // Without live in the list its address is not known, and offering to set one could put an address over
    // one it already has
    if (!live) {
        return (
            <section className={styles.block} aria-labelledby="primary-domain">
                <h2 id="primary-domain">Primary domain</h2>
                <p className={styles.note}>live&apos;s address could not be read, so it cannot be changed here right now.</p>
            </section>
        )
    }
    const current = live.domain ?? null
    return <PrimaryDomain key={current ?? ''} id={id} environment={LIVE} current={current} said={said} onSaid={setSaid} />
}

function DeleteSite({ id, name }: { id: string, name: string }) {
    const router = useRouter()
    const [open, setOpen] = useState(false)
    const [typed, setTyped] = useState('')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    function show() {
        setTyped('')
        setError(null)
        setOpen(true)
    }

    async function go() {
        setPending(true)
        setError(null)
        try {
            const result = await deleteSiteAction(id, typed.trim())
            if (result.ok) {
                // This page is for a site that no longer exists, so there is nothing to stay and read here
                router.push('/portal')
                router.refresh()
                return
            }
            setError(result.error)
        } catch {
            setError('That did not work. Try reloading the page.')
        }
        setPending(false)
    }

    // Typed back exactly, because hostd compares it exactly
    const ready = typed.trim() === name && !pending

    return (
        <section className={styles.deleteSite}>
            <h3>Delete this site</h3>
            <p className={styles.note}>
                Stops the site, removes it from hostd and takes its Apache configuration off, so it stops
                being served. Its folder, volumes and databases stay on the server.
            </p>
            <div>
                <Button variant="danger" onClick={show}>Delete site</Button>
            </div>

            <Dialog
                open={open}
                onClose={() => { if (!pending) setOpen(false) }}
                title={`Delete ${name}`}
                footer={
                    <>
                        <Button variant="quiet" disabled={pending} onClick={() => setOpen(false)}>Keep it</Button>
                        <Button variant="danger" disabled={!ready} onClick={go}>
                            {pending ? 'Deleting...' : 'Delete site'}
                        </Button>
                    </>
                }
            >
                {error && (
                    <div className={styles.said}>
                        <Callout tone="crit" title="It was not deleted">{error}</Callout>
                    </div>
                )}
                <p className={styles.note}>
                    {`The containers are stopped first. If they cannot be stopped, nothing is deleted. `
                        + `Anything linking it to a client goes too. The files in its folder are left alone, `
                        + `so it can be set up again from them, or removed by hand on the server.`}
                </p>
                <Field
                    label={`Type ${name} to confirm`}
                    value={typed}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={event => setTyped(event.target.value)}
                />
            </Dialog>
        </section>
    )
}

// What the form holds for one environment, or undefined when it holds nothing. Own properties only: an
// environment may be called constructor, which every plain object would otherwise answer with a function.
function ownValue<T>(values: Record<string, T>, name: string): T | undefined {
    return Object.hasOwn(values, name) ? values[name] : undefined
}

function blankToNull(value: string | undefined): string | null {
    return value === undefined || value.trim() === '' ? null : value
}

// Order matters here, not just membership: CAPABILITIES is rebuilt in the registry's own order (see the
// comment in save() above), so a real reorder should still count as a change even though nothing else
// noticed, but the everyday case (nothing ticked or unticked) always rebuilds the same order it started
// from, which is what makes a plain positional compare the right one rather than a set compare.
function sameList(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index])
}
