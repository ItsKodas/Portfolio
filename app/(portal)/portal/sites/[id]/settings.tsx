'use client'

// The registry entry itself: which capabilities the project has, its repo, and each environment's
// branch. This is the only form on the site page that changes the registry rather than asking hostd to
// act on what is already in it, which is why it is admin only end to end (actions.ts's allow(id, true),
// the same gate saveEnvAction uses).

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Field } from '@/ui/Field/Field'
import { saveSettingsAction, type SiteActionResult } from './actions'
import styles from './site.module.css'

// hostd/src/shared/registry.ts's CAPABILITIES, in its order. built: false is the four the registry
// accepts but hostd cannot act on yet: ticking one only records that the project has it, the same as
// today's registry entries already do by hand.
const CAPABILITIES: ReadonlyArray<{ key: string, built: boolean }> = [
    { key: 'lifecycle', built: true },
    { key: 'logs', built: true },
    { key: 'files', built: false },
    { key: 'backups', built: false },
    { key: 'domains', built: false },
    { key: 'provision', built: false },
    { key: 'env', built: true },
    { key: 'deploy', built: true },
]

// Said once, beside the list, rather than on each of the four it is about: repeating it eight times would
// bury the one thing it needs to say under seven copies of the same sentence.
const NOT_BUILT = 'files, backups, domains and provision are designed but not built yet. hostd cannot act on '
    + 'them, so ticking one here does not switch anything on. Provision, once it is built, will let this '
    + 'project be re-provisioned and removed through the API.'

// A deploy checks nothing before it is asked to run, because there is nothing here to check it with: it
// needs a git repository already at the environment's dir, and hostd only finds that out when it runs.
const CANNOT_CHECK = 'A deploy needs a git repository already at the environment\'s dir (dir/.git). hostd '
    + 'only finds that out when it runs. This form cannot check that ahead of it.'

export function SiteSettingsForm({ id, capabilities, repo, credential, environments, branches = null, branchesError = null, credentials = null, credentialsError = null }: {
    id: string
    capabilities: string[]
    repo: string | null
    credential: string | null
    environments: Array<{ name: string, branch: string | null, dir?: string, port?: number }>
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
            const nextBranch = blankToNull(branchValues[env.name])
            if (nextBranch !== (env.branch ?? null)) changedBranches[env.name] = nextBranch
        }

        const payload: {
            capabilities?: string[]
            repo?: string | null
            credential?: string | null
            branches?: Record<string, string | null>
        } = {}
        if (!sameList(nextCapabilities, capabilities)) payload.capabilities = nextCapabilities
        if (nextRepo !== repo) payload.repo = nextRepo
        if (nextCredential !== credential) payload.credential = nextCredential
        if (Object.keys(changedBranches).length > 0) payload.branches = changedBranches

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
                const branchValue = branchValues[env.name] ?? ''
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
                        {env.port !== undefined && <p className={styles.envMeta}>port {env.port}</p>}
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
        </div>
    )
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
