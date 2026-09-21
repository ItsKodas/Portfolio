'use client'

// Everything on the Domains tab that changes something. All of it is the operator's: hostd keeps
// 'domains' among its admin-only policy verbs and leaves only 'domains-read' to an owner, so the panel
// never renders any of this for a client, and each action re-derives who is asking from the session
// anyway. Nothing here decides anything: it names an environment and a hostname, and that is all it is
// trusted with.

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { AdoptPreview } from '@/server/hostd/domains'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { adoptAction, adoptPreviewAction, addDomainAction, removeDomainAction, verifyDomainAction, type SiteActionResult } from './actions'
import styles from './site.module.css'

const BROKE = 'That did not work. Try reloading the page.'

// What the action said, wherever it is small enough to sit beside the thing that caused it. A refusal is
// the operator's own words back from hostd, so it is shown rather than summarised.
function Said({ said }: { said: SiteActionResult | null }) {
    if (!said) return null
    return said.ok
        ? <span className={styles.state}>{said.message}</span>
        : <span className={styles.stateBad}>{said.error}</span>
}

export function AddDomain({ id, environment }: { id: string, environment: string }) {
    const router = useRouter()
    const [hostname, setHostname] = useState('')
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)

    async function add() {
        setPending(true)
        setSaid(null)
        try {
            const result = await addDomainAction(id, environment, hostname.trim())
            setSaid(result)
            if (result.ok) {
                setHostname('')
                router.refresh()
            }
        } catch {
            setSaid({ ok: false, error: BROKE })
        } finally {
            setPending(false)
        }
    }

    return (
        <div className={styles.addDomain}>
            <Field
                label="Hostname"
                value={hostname}
                spellCheck={false}
                autoComplete="off"
                placeholder="shop.example.com"
                hint="A name whose DNS already points at this server. hostd checks it before it goes live."
                onChange={event => setHostname(event.target.value)}
            />
            <div className={styles.addAction}>
                <Button variant="primary" disabled={pending || !hostname.trim()} onClick={add}>
                    {pending ? 'Adding...' : 'Add'}
                </Button>
                <Said said={said} />
            </div>
        </div>
    )
}

type ActionProps = {
    id: string
    environment: string
    hostname: string
    // The main address of the environment has no remove button. Changing it is deliberately out of scope
    // here, and a button that only ever answers hostd's refusal is worse than no button.
    removable: boolean
}

export function DomainActions({ id, environment, hostname, removable }: ActionProps) {
    const router = useRouter()
    const [pending, setPending] = useState<string | null>(null)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    const [asking, setAsking] = useState(false)

    async function run(what: string, action: () => Promise<SiteActionResult>) {
        setPending(what)
        setSaid(null)
        try {
            const result = await action()
            setSaid(result)
            if (result.ok) router.refresh()
        } catch {
            setSaid({ ok: false, error: BROKE })
        } finally {
            setPending(null)
            setAsking(false)
        }
    }

    return (
        <div className={styles.rowActions}>
            <Button
                size="small"
                disabled={pending !== null}
                onClick={() => run('verify', () => verifyDomainAction(id, environment, hostname))}
            >
                {pending === 'verify' ? 'Checking...' : 'Check again'}
            </Button>

            {removable && (
                <Button size="small" variant="danger" disabled={pending !== null} onClick={() => setAsking(true)}>
                    Remove
                </Button>
            )}

            <Said said={said} />

            <Dialog
                open={asking}
                onClose={() => setAsking(false)}
                title="Remove this address"
                footer={
                    <>
                        <Button variant="quiet" onClick={() => setAsking(false)}>Leave it</Button>
                        <Button
                            variant="danger"
                            disabled={pending !== null}
                            onClick={() => run('remove', () => removeDomainAction(id, environment, hostname))}
                        >
                            {pending === 'remove' ? 'Removing...' : 'Remove it'}
                        </Button>
                    </>
                }
            >
                <p>
                    <span className={styles.mono}>{hostname}</span> stops being served the moment the
                    configuration is reloaded, which is a few seconds. Anyone who visits it after that
                    reaches whatever else answers on this server.
                </p>
                <p className={styles.note}>
                    Its DNS record is not ours and is left alone. Adding the name back later is the same
                    box you removed it from.
                </p>
            </Dialog>
        </div>
    )
}

type AdoptProps = {
    id: string
    environment: string
    // hostd makes the operator type the project's name back, not its id: the id is already in the URL
    // they are looking at, so typing it would confirm nothing about which site they meant.
    projectName: string
}

export function AdoptSite({ id, environment, projectName }: AdoptProps) {
    const router = useRouter()
    const [open, setOpen] = useState(false)
    const [preview, setPreview] = useState<AdoptPreview | null>(null)
    const [loading, setLoading] = useState(false)
    const [typed, setTyped] = useState('')
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)

    // The preview is read when the dialog opens rather than while the page renders, because it is the
    // only thing on this tab that makes the agent walk sites-enabled, and almost nobody opens it.
    async function look() {
        setOpen(true)
        setTyped('')
        setSaid(null)
        setPreview(null)
        setLoading(true)
        try {
            const result = await adoptPreviewAction(id, environment)
            if (result.ok) setPreview(result.preview)
            else setSaid({ ok: false, error: result.error })
        } catch {
            setSaid({ ok: false, error: BROKE })
        } finally {
            setLoading(false)
        }
    }

    async function go() {
        setPending(true)
        setSaid(null)
        try {
            const result = await adoptAction(id, environment, typed.trim())
            setSaid(result)
            if (result.ok) {
                setOpen(false)
                router.refresh()
            }
        } catch {
            setSaid({ ok: false, error: BROKE })
        } finally {
            setPending(false)
        }
    }

    // Typed back exactly, because this replaces the file a live site is being served from
    const named = typed.trim() === projectName
    const ready = preview !== null && preview.adoptable && named && !pending

    return (
        <div className={styles.rowActions}>
            <Button size="small" onClick={look}>Adopt this site</Button>
            <Said said={open ? null : said} />

            <Dialog
                open={open}
                onClose={() => setOpen(false)}
                title="Let hostd serve this site"
                footer={
                    <>
                        <Button variant="quiet" onClick={() => setOpen(false)}>Leave it alone</Button>
                        <Button variant="danger" disabled={!ready} onClick={go}>
                            {pending ? 'Writing...' : 'Replace the configuration'}
                        </Button>
                    </>
                }
            >
                {loading && <p className={styles.empty}>Reading what is there now...</p>}

                {said && !said.ok && (
                    <div className={styles.said}>
                        <Callout tone="crit" title="That did not happen">{said.error}</Callout>
                    </div>
                )}

                {preview && (
                    <>
                        {!preview.adoptable && (
                            <div className={styles.said}>
                                <Callout tone="crit" title="This one cannot be taken over from here">
                                    One of the files below uses a directive this parser will not follow,
                                    so what it serves cannot be established. hostd refuses the change
                                    rather than guessing, and the file has to be simplified by hand first.
                                </Callout>
                            </div>
                        )}

                        {preview.extraNames.length > 0 && (
                            <div className={styles.said}>
                                <Callout tone="warn" title="These names would stop being served">
                                    {`${preview.extraNames.join(', ')}. The file below answers them today `
                                        + 'and hostd has never been told about them. Add them above first '
                                        + 'if they are still wanted.'}
                                </Callout>
                            </div>
                        )}

                        <div className={styles.sideBySide}>
                            <section className={styles.pane}>
                                <h3 className={styles.paneHead}>What is there now</h3>
                                {preview.claims.length === 0
                                    ? <p className={styles.empty}>
                                        Nothing hand-written answers for this site, so there is nothing to
                                        replace. It gets a configuration hostd owns from here on.
                                    </p>
                                    : preview.claims.map(claim => (
                                        <div className={styles.claim} key={claim.path}>
                                            <p className={styles.mono}>{claim.path}</p>
                                            <p className={styles.note}>
                                                {claim.names.length
                                                    ? `serves ${claim.names.join(', ')}`
                                                    : 'serves no name this could read'}
                                            </p>
                                            {claim.unsupported && (
                                                <p className={styles.stateBad}>{claim.unsupported}</p>
                                            )}
                                            {/* The file itself, whole and unedited. hostd reads two
                                                directives out of it and this replaces all of them, so a
                                                rewrite, a basic auth block or a bespoke error page is
                                                only ever visible here. It is the reason the pane
                                                exists, not a detail under the path. */}
                                            <pre className={styles.vhost}>{claim.text}</pre>
                                        </div>
                                    ))}
                            </section>

                            <section className={styles.pane}>
                                <h3 className={styles.paneHead}>What hostd would write</h3>
                                <pre className={styles.vhost}>{preview.proposed}</pre>
                            </section>
                        </div>

                        <Field
                            label={`Type ${projectName} to confirm`}
                            value={typed}
                            spellCheck={false}
                            autoComplete="off"
                            hint="The old file is switched off and the new one goes in, in one reload. If Apache refuses it, hostd puts the previous one back by itself."
                            onChange={event => setTyped(event.target.value)}
                        />
                    </>
                )}
            </Dialog>
        </div>
    )
}
