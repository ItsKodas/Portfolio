'use client'

// Who may reach a site and what they may do there, drawn the same way from either end: a client's page lists
// their sites, a site's Access tab lists its clients. Both call the same three actions, so the two pages can
// never disagree about what a grant is.

import { useState } from 'react'

import { siteSchema } from '@/server/clients/schema'
import { DEFAULT_PERMISSIONS, NEEDS, PERMISSIONS, PERMISSION_LABELS, type Permission } from '@/server/sites/permissions'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Field } from '@/ui/Field/Field'
import { DeleteOutline } from '@/ui/icons'
import { grantSiteAction, revokeSiteAction, setSitePermissionsAction, type AdminResult } from '../clients/actions'
import styles from './access.module.css'

function useAction() {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    async function run(action: () => Promise<AdminResult>, onDone?: () => void) {
        setPending(true)
        setError(null)
        try {
            const result = await action()
            if (result.ok) onDone?.()
            else setError(result.error)
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }
    return { pending, error, run }
}

const Problem = ({ error }: { error: string | null }) => (
    error ? <div className={styles.problem}><Callout tone="crit" title={error}>{null}</Callout></div> : null
)

// Kept in PERMISSIONS order whatever order the boxes were ticked in, so a saved list compares equal to the
// one it was loaded from.
const ordered = (chosen: ReadonlySet<Permission>) => PERMISSIONS.filter(permission => chosen.has(permission))

export function PermissionPicker({ value, onChange, legend }: {
    value: readonly Permission[]
    onChange: (next: Permission[]) => void
    legend: string
}) {
    const chosen = new Set(value)
    return (
        <fieldset className={styles.permissions} aria-label={legend}>
            {PERMISSIONS.map(permission => (
                <label key={permission} className={styles.permission} title={PERMISSION_LABELS[permission].note}>
                    <input
                        type="checkbox"
                        checked={chosen.has(permission)}
                        onChange={event => {
                            const next = new Set(chosen)
                            // A level above another brings it along when ticked, and goes with it when that
                            // one is unticked: editing env files without the Environments tab means nothing.
                            const above = PERMISSIONS.filter(other => NEEDS[other] === permission)
                            const below = NEEDS[permission]
                            if (event.target.checked) {
                                next.add(permission)
                                if (below) next.add(below)
                            } else {
                                next.delete(permission)
                                above.forEach(other => next.delete(other))
                            }
                            onChange(ordered(next))
                        }}
                    />
                    {PERMISSION_LABELS[permission].label}
                </label>
            ))}
        </fieldset>
    )
}

// One grant: whose, on which site, and what it allows. Save appears only once the boxes differ from what is
// stored, so a page of grants never reads as a page of unsaved changes.
export function AccessRow({ clientId, siteId, title, subtitle, href, permissions }: {
    clientId: string
    siteId: string
    title: string
    subtitle: string
    href: string
    permissions: readonly Permission[]
}) {
    const { pending, error, run } = useAction()
    const [value, setValue] = useState<Permission[]>([...permissions])
    const changed = value.join(',') !== permissions.join(',')

    return (
        <div className={styles.row}>
            <div className={styles.head}>
                <p className={styles.name}>
                    <a className={styles.link} href={href}>{title}</a>
                    <span className={styles.sub}>{subtitle}</span>
                </p>
                <Button
                    variant="quiet"
                    size="small"
                    aria-label={`Remove access for ${title}`}
                    disabled={pending}
                    onClick={() => run(() => revokeSiteAction(clientId, siteId))}
                >
                    <DeleteOutline size={15} />
                </Button>
            </div>
            <PermissionPicker value={value} onChange={setValue} legend={`What ${title} allows`} />
            {changed && (
                <div className={styles.actions}>
                    <Button size="small" variant="primary" disabled={pending}
                        onClick={() => run(() => setSitePermissionsAction(clientId, siteId, value))}>
                        Save
                    </Button>
                    <Button size="small" variant="quiet" disabled={pending} onClick={() => setValue([...permissions])}>Cancel</Button>
                </div>
            )}
            <Problem error={error} />
        </div>
    )
}

const SEES = 'Any access shows the site and its Overview. Settings, deploying and changing domains stay yours '
    + 'whatever is ticked. Env files are theirs to read and edit only with Edit env files, which a new grant leaves off.'

// From a client's page: any site, named by its project id in hostd's registry
export function GrantSiteForm({ clientId }: { clientId: string }) {
    const { pending, error, run } = useAction()
    const [projectId, setProjectId] = useState('')
    const [name, setName] = useState('')
    const [permissions, setPermissions] = useState<Permission[]>([...DEFAULT_PERMISSIONS])
    const valid = siteSchema.safeParse({ projectId, name }).success

    return (
        <form className={styles.grant} onSubmit={event => {
            event.preventDefault()
            run(() => grantSiteAction(clientId, { projectId, name }, permissions), () => {
                setProjectId('')
                setName('')
                setPermissions([...DEFAULT_PERMISSIONS])
            })
        }}>
            <div className={styles.fields}>
                <Field label="Project id" value={projectId} onChange={event => setProjectId(event.target.value)} />
                <Field label="Site name" value={name} onChange={event => setName(event.target.value)} />
            </div>
            <PermissionPicker value={permissions} onChange={setPermissions} legend="What the new access allows" />
            <p className={styles.note}>{SEES}</p>
            <div><Button type="submit" disabled={pending || !valid}>Give access</Button></div>
            <Problem error={error} />
        </form>
    )
}

// From a site's Access tab: this site, to any client who does not already have it
export function GrantClientForm({ projectId, name, clients }: {
    projectId: string
    name: string
    clients: Array<{ id: string, name: string }>
}) {
    const { pending, error, run } = useAction()
    const [clientId, setClientId] = useState('')
    const [permissions, setPermissions] = useState<Permission[]>([...DEFAULT_PERMISSIONS])

    if (clients.length === 0) return <p className={styles.note}>Every client already has access to this site.</p>

    return (
        <form className={styles.grant} onSubmit={event => {
            event.preventDefault()
            run(() => grantSiteAction(clientId, { projectId, name }, permissions), () => {
                setClientId('')
                setPermissions([...DEFAULT_PERMISSIONS])
            })
        }}>
            <Field as="select" label="Client" value={clientId} onChange={event => setClientId(event.target.value)}>
                <option value="">Pick a client</option>
                {clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
            </Field>
            <PermissionPicker value={permissions} onChange={setPermissions} legend="What the new access allows" />
            <p className={styles.note}>{SEES}</p>
            <div><Button type="submit" disabled={pending || clientId === ''}>Give access</Button></div>
            <Problem error={error} />
        </form>
    )
}
