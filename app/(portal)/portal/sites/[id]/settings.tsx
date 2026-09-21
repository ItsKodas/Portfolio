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

export function SiteSettingsForm({ id, capabilities, repo, environments }: {
    id: string
    capabilities: string[]
    repo: string | null
    environments: Array<{ name: string, branch: string | null, dir?: string, port?: number }>
}) {
    const router = useRouter()
    const [checked, setChecked] = useState(() => new Set(capabilities))
    const [repoValue, setRepoValue] = useState(repo ?? '')
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

        const payload: { capabilities?: string[], repo?: string | null, branches?: Record<string, string | null> } = {}
        if (!sameList(nextCapabilities, capabilities)) payload.capabilities = nextCapabilities
        if (nextRepo !== repo) payload.repo = nextRepo
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

            {environments.map(env => (
                <div key={env.name} className={styles.envSettings}>
                    <p className={styles.envName}>{env.name}</p>
                    {env.dir && <p className={styles.mono}>{env.dir}</p>}
                    {env.port !== undefined && <p className={styles.envMeta}>port {env.port}</p>}
                    <Field
                        label={`${env.name} branch`}
                        value={branchValues[env.name] ?? ''}
                        onChange={event => setBranchValues(prev => ({ ...prev, [env.name]: event.target.value }))}
                    />
                </div>
            ))}

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
