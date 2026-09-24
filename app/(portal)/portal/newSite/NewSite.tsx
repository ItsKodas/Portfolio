'use client'

// The sidebar's New site button and the form behind it. Everything the form offers is read when it opens
// rather than with every page, since it is opened rarely and the page is read constantly.

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { CAPABILITIES, NOT_BUILT, SWITCHES } from '../sites/features'
import site from '../sites/[id]/site.module.css'
import { usePortCheck } from '../sites/usePortCheck'
import { createSiteAction, newSiteOptionsAction, type NewSiteOptions } from './actions'
import { newSiteSchema, slugOf, type NewSiteInput } from './schema'
import styles from './newSite.module.css'

// The four hostd can act on today, plus domains, which the first vhost needs
const DEFAULT_CAPABILITIES = ['lifecycle', 'logs', 'domains', 'env', 'deploy']

const blank = (): NewSiteInput => ({
    name: '', id: '', dir: '', client: '', repo: '', credential: '', branch: 'main',
    compose: ['docker-compose.yml'], capabilities: DEFAULT_CAPABILITIES,
    websockets: false, flexibleSsl: false, domain: '', certificate: 'letsencrypt', port: '', deploy: false,
})

type Loaded = NewSiteOptions & { ok: true }

export function NewSiteButton() {
    const [open, setOpen] = useState(false)
    return (
        // Clicks stay in here: the sidebar closes its mobile drawer on any button clicked inside it, and
        // that would pull focus out of the form on every one of its own buttons.
        <div className={styles.slot} onClick={event => event.stopPropagation()}>
            <button type="button" className={styles.button} onClick={() => setOpen(true)}>
                <span>New site</span>
                <span aria-hidden className={styles.plus}>+</span>
            </button>
            {open && <NewSiteDialog onClose={() => setOpen(false)} />}
        </div>
    )
}

function NewSiteDialog({ onClose }: { onClose: () => void }) {
    const router = useRouter()
    const [values, setValues] = useState<NewSiteInput>(blank)
    // Whether the id and folder still follow the name, which they do until either is typed into
    const [idTyped, setIdTyped] = useState(false)
    const [dirTyped, setDirTyped] = useState(false)
    // Whether the port still follows hostd's suggestion, which it does until it is typed into
    const [portTyped, setPortTyped] = useState(false)
    const [options, setOptions] = useState<Loaded | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [tried, setTried] = useState(false)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [created, setCreated] = useState<{ id: string, warnings: string[] } | null>(null)
    const portCheck = usePortCheck(values.port, null)

    useEffect(() => {
        if (!portTyped && portCheck.suggested !== null) setValues(prev => ({ ...prev, port: String(portCheck.suggested) }))
    }, [portTyped, portCheck.suggested])

    // On open: this component only exists while the dialog is open
    useEffect(() => {
        let live = true
        newSiteOptionsAction()
            .then(result => {
                if (!live) return
                if (result.ok) setOptions(result)
                else setLoadError(result.error)
            })
            .catch(() => { if (live) setLoadError('The client list could not be read. Try reloading the page.') })
            .finally(() => { if (live) setLoading(false) })
        return () => { live = false }
    }, [])

    const set = <K extends keyof NewSiteInput>(key: K, value: NewSiteInput[K]) => setValues(prev => ({ ...prev, [key]: value }))

    function setName(name: string) {
        setValues(prev => {
            const id = idTyped ? prev.id : slugOf(name)
            return { ...prev, name, id, dir: dirTyped ? prev.dir : id }
        })
    }

    function setId(id: string) {
        setIdTyped(true)
        setValues(prev => ({ ...prev, id, dir: dirTyped ? prev.dir : id }))
    }

    function toggleCapability(key: string) {
        setValues(prev => {
            const has = prev.capabilities.includes(key)
            // Rebuilt in the registry's own order, as the Settings tab does
            const next = CAPABILITIES.map(cap => cap.key).filter(k => (k === key ? !has : prev.capabilities.includes(k)))
            return { ...prev, capabilities: next, deploy: next.includes('deploy') ? prev.deploy : false }
        })
    }

    const parsed = newSiteSchema.safeParse(values)
    const problems = new Map<string, string>()
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            const key = String(issue.path[0] ?? '')
            if (!problems.has(key)) problems.set(key, issue.message)
        }
    }
    const problem = (key: keyof NewSiteInput) => (tried ? problems.get(key) : undefined)

    async function submit() {
        setTried(true)
        setError(null)
        if (!parsed.success) return
        if (portCheck.problem || portCheck.checking) return
        setPending(true)
        try {
            const result = await createSiteAction(values)
            if (!result.ok) { setError(result.error); return }
            router.refresh()
            if (result.warnings.length === 0) {
                router.push(`/portal/sites/${result.id}`)
                onClose()
                return
            }
            setCreated(result)
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }

    if (created) {
        return (
            <Dialog
                open
                onClose={onClose}
                title="Site created"
                footer={(
                    <>
                        <Button onClick={onClose}>Close</Button>
                        <Button variant="primary" onClick={() => { router.push(`/portal/sites/${created.id}`); onClose() }}>Open the site</Button>
                    </>
                )}
            >
                <Callout tone="warn" title={`${created.id} is registered, with some things left to do`}>
                    <ul className={styles.warnings}>
                        {created.warnings.map(warning => <li key={warning}>{warning}</li>)}
                    </ul>
                </Callout>
            </Dialog>
        )
    }

    const credentials = options?.credentials ?? null
    const hasDomain = values.domain.trim() !== ''
    const canDeploy = values.capabilities.includes('deploy')

    return (
        <Dialog
            open
            onClose={pending ? () => {} : onClose}
            title="New site"
            footer={(
                <>
                    <Button onClick={onClose} disabled={pending}>Cancel</Button>
                    <Button variant="primary" onClick={submit} disabled={pending || loading || portCheck.checking}>
                        {pending ? 'Creating...' : 'Create site'}
                    </Button>
                </>
            )}
        >
            <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit() }}>
                {loadError && <Callout tone="crit" title={loadError}>{null}</Callout>}

                <section className={styles.section}>
                    <Field label="Name" value={values.name} onChange={event => setName(event.target.value)} error={problem('name')} autoFocus />
                    <div className={styles.pair}>
                        <Field
                            label="Project id"
                            hint="hostd's name for it. Cannot be changed later."
                            value={values.id}
                            onChange={event => setId(event.target.value)}
                            error={problem('id')}
                        />
                        <Field
                            label="Folder"
                            hint={`/var/www/${values.dir || '...'}`}
                            value={values.dir}
                            onChange={event => { setDirTyped(true); set('dir', event.target.value) }}
                            error={problem('dir')}
                        />
                    </div>
                    <Field
                        as="select"
                        label="Client"
                        hint={values.client === '' ? 'Only you will see this site.' : 'This client will see the site in their portal.'}
                        value={values.client}
                        onChange={event => set('client', event.target.value)}
                        disabled={!options}
                        error={problem('client')}
                    >
                        <option value="">None (managed by you)</option>
                        {options?.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
                    </Field>
                </section>

                <section className={styles.section}>
                    <p className={styles.heading}>Source</p>
                    <Field
                        label="Repo"
                        placeholder="git@github.com:ItsKodas/site.git"
                        value={values.repo}
                        onChange={event => set('repo', event.target.value)}
                        error={problem('repo')}
                    />
                    <div className={styles.pair}>
                        {credentials ? (
                            <Field as="select" label="Account" value={values.credential} onChange={event => set('credential', event.target.value)}>
                                <option value="">default (GITHUB_TOKEN)</option>
                                {credentials.map(name => <option key={name} value={name}>{name}</option>)}
                            </Field>
                        ) : (
                            <Field
                                label="Account"
                                hint={options?.credentialsError ? `The host's accounts could not be read: ${options.credentialsError}` : 'Blank for the default token.'}
                                value={values.credential}
                                onChange={event => set('credential', event.target.value)}
                                error={problem('credential')}
                            />
                        )}
                        <Field
                            label="Branch"
                            hint="Deploys run from this branch."
                            value={values.branch}
                            onChange={event => set('branch', event.target.value)}
                            error={problem('branch')}
                        />
                    </div>

                    <fieldset className={styles.compose}>
                        <legend>Compose files</legend>
                        <p className={site.note}>Relative to the folder, in the order they merge. hostd checks they resolve after cloning, and nothing is kept if they do not.</p>
                        {values.compose.map((file, index) => (
                            <div key={index} className={styles.composeRow}>
                                <input
                                    className={styles.composeInput}
                                    aria-label={`Compose file ${index + 1}`}
                                    value={file}
                                    onChange={event => set('compose', values.compose.map((one, i) => (i === index ? event.target.value : one)))}
                                />
                                <Button
                                    variant="quiet"
                                    size="small"
                                    aria-label={`Remove compose file ${index + 1}`}
                                    disabled={values.compose.length === 1}
                                    onClick={() => set('compose', values.compose.filter((_, i) => i !== index))}
                                >
                                    &times;
                                </Button>
                            </div>
                        ))}
                        {values.compose.length < 8 && (
                            <Button variant="quiet" size="small" onClick={() => set('compose', [...values.compose, ''])}>Add a compose file</Button>
                        )}
                        {problem('compose') && <p className={styles.error}>{problem('compose')}</p>}
                    </fieldset>
                </section>

                <section className={styles.section}>
                    <fieldset className={site.capabilities}>
                        <legend>Features</legend>
                        {CAPABILITIES.map(cap => (
                            <label key={cap.key} className={[site.capability, !cap.built && site.capabilityOff].filter(Boolean).join(' ')}>
                                <input type="checkbox" checked={values.capabilities.includes(cap.key)} onChange={() => toggleCapability(cap.key)} />
                                {cap.key}
                            </label>
                        ))}
                    </fieldset>
                    <p className={site.note}>{NOT_BUILT}</p>
                    {SWITCHES.map(({ key, label, note }) => (
                        <div key={key}>
                            <label className={site.capability}>
                                <input type="checkbox" checked={values[key]} onChange={event => set(key, event.target.checked)} />
                                {label}
                            </label>
                            <p className={site.note}>{note}</p>
                        </div>
                    ))}
                </section>

                <section className={styles.section}>
                    <p className={styles.heading}>Address</p>
                    <div className={styles.pair}>
                        <Field
                            label="Domain"
                            placeholder="example.com"
                            hint="Optional. hostd writes its vhost once the site is created."
                            value={values.domain}
                            onChange={event => set('domain', event.target.value)}
                            error={problem('domain')}
                        />
                        <Field
                            as="select"
                            label="Certificate"
                            value={values.certificate}
                            onChange={event => set('certificate', event.target.value as NewSiteInput['certificate'])}
                            disabled={!hasDomain}
                        >
                            <option value="letsencrypt">Let&apos;s Encrypt</option>
                            <option value="cloudflare-origin">Cloudflare origin</option>
                        </Field>
                    </div>
                    {hasDomain && !values.capabilities.includes('domains') && (
                        <p className={site.note}>The domains feature is off, so hostd will record the domain but cannot write its vhost.</p>
                    )}
                    <Field
                        label="Port"
                        inputMode="numeric"
                        hint={portCheck.error
                            ? `The dedi's ports could not be checked: ${portCheck.error}`
                            : 'The port the site listens on. hostd publishes it to the site\'s service on 127.0.0.1, whatever the compose file says.'}
                        value={values.port}
                        onChange={event => { setPortTyped(true); set('port', event.target.value) }}
                        error={portCheck.problem ?? problem('port')}
                    />
                </section>

                <label className={site.capability}>
                    <input type="checkbox" checked={values.deploy} disabled={!canDeploy} onChange={event => set('deploy', event.target.checked)} />
                    Deploy after creating
                </label>
                <p className={site.note}>
                    {canDeploy
                        ? 'Leave this off if the site needs its env files filled in first, which most do.'
                        : 'Needs the deploy feature.'}
                </p>

                {pending && <p className={site.note}>Cloning the repository and checking its compose files. This can take a minute.</p>}
                {error && <Callout tone="crit" title="The site was not created">{error}</Callout>}
                {/* Enter in a field submits, like any other form */}
                <button type="submit" hidden />
            </form>
        </Dialog>
    )
}
