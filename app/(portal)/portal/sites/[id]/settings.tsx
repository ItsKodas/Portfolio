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

    function toggle(key: string) {
        setChecked(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    async function save() {
        setPending(true)
        setSaid(null)
        try {
            const result = await saveSettingsAction(id, {
                // Every field is sent every time, not only what changed: a present field means "set
                // this" to hostd, the current value is what the form already holds, and sending it back
                // is idempotent, so there is nothing a diff against the original would buy.
                capabilities: CAPABILITIES.filter(cap => checked.has(cap.key)).map(cap => cap.key),
                repo: repoValue.trim() === '' ? null : repoValue,
                branches: Object.fromEntries(
                    environments.map(env => [env.name, blankToNull(branchValues[env.name])]),
                ),
            })
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
        </div>
    )
}

function blankToNull(value: string | undefined): string | null {
    return value === undefined || value.trim() === '' ? null : value
}
