'use client'

// Everything in the Environments tab's Domains section that changes something, and the root domain
// control Settings draws. All of it is the operator's: hostd keeps
// 'domains' among its admin-only policy verbs and leaves only 'domains-read' to an owner, so the panel
// never renders any of this for a client, and each action re-derives who is asking from the session
// anyway. Nothing here decides anything: it names an environment and a hostname, and that is all it is
// trusted with.

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { AdoptPreview } from '@/server/hostd/domains'
import { siteBase } from '@/server/hostd/environmentAddress'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import {
    adoptAction, adoptPreviewAction, addDomainAction, makePrimaryDomainAction, removeDomainAction,
    saveSettingsAction, setRootDomainAction, verifyDomainAction, type SiteActionResult,
} from './actions'
import type { SwitchKey } from '../features'
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

// A hostname for the environment being viewed. hostd makes the first name an environment gets its
// primary and every later one an alias redirecting to it, so this is open whether or not the environment
// has an address yet.
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
        <section className={styles.block}>
            <h4>Add an address</h4>
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
            <p className={styles.note}>
                The first name an environment gets becomes its address. Every name after that redirects to
                it, so the site is only ever reachable at one URL.
            </p>
        </section>
    )
}

// The site's root domain, set from Settings: the base new environments' addresses sit one label below
// (uat1.example.com), and an address of live's, so it redirects to live's main address like any other
// alias. Saving one live does not have yet adds it to live first. Not set follows live's main address
// without a leading www.
type RootProps = {
    id: string
    current: string | null
    // live's main address, named in what an unset root falls back to
    livePrimary: string | null
}

export function RootDomainField({ id, current, livePrimary }: RootProps) {
    const router = useRouter()
    const [hostname, setHostname] = useState(current ?? '')
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)

    const wanted = hostname.trim().toLowerCase()

    async function save() {
        setPending(true)
        setSaid(null)
        try {
            const result = await setRootDomainAction(id, wanted === '' ? null : wanted)
            setSaid(result)
            if (result.ok) router.refresh()
        } catch {
            setSaid({ ok: false, error: BROKE })
        } finally {
            setPending(false)
        }
    }

    const fallback = livePrimary ? siteBase(livePrimary) : null
    return (
        <section className={styles.block} aria-labelledby="root-domain">
            <h2 id="root-domain">Root domain</h2>
            <div className={styles.addDomain}>
                <Field
                    label="Root domain"
                    value={hostname}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={fallback ?? 'example.com'}
                    hint={'New environments get an address one level below this, like uat1.example.com. It is one of '
                        + "live's addresses and redirects to live's main address, which is chosen on live's Domains section."}
                    onChange={event => setHostname(event.target.value)}
                />
                <div className={styles.addAction}>
                    <Button variant="primary" disabled={pending || wanted === (current ?? '')} onClick={save}>
                        {pending ? 'Setting...' : 'Set root domain'}
                    </Button>
                    <Said said={said} />
                </div>
            </div>
            {current === null && (
                <p className={styles.note}>
                    {fallback
                        ? `Not set, so new environments go under ${fallback}, from live's main address.`
                        : 'Not set, and live has no address yet, so new environments can only go under horizons.gg.'}
                </p>
            )}
        </section>
    )
}

// One of an environment's render-only switches, drawn on its main address's row like Cloudflare's proxy
// cloud: lit when on, grey when off, and one click flips it. They belong to the environment rather than to
// any one hostname (an alias only redirects to the main address), which is why only that row has them.
// Flipping one rewrites the environment's Apache configuration if hostd serves it.
type SwitchProps = {
    id: string
    environment: string
    flag: SwitchKey
    on: boolean
}

export function RowSwitch({ id, environment, flag, on }: SwitchProps) {
    const router = useRouter()
    const [value, setValue] = useState(on)
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    const { label, short } = SWITCH_LABELS[flag]

    async function flip() {
        const next = !value
        setPending(true)
        setSaid(null)
        setValue(next)
        try {
            const result = await saveSettingsAction(id, { [flag]: { [environment]: next } })
            if (result.ok) router.refresh()
            else {
                setValue(!next)
                setSaid(result)
            }
        } catch {
            setValue(!next)
            setSaid({ ok: false, error: BROKE })
        } finally {
            setPending(false)
        }
    }

    return (
        <>
            <button
                type="button"
                role="switch"
                aria-checked={value}
                aria-label={`${environment} ${label}`}
                title={`${label}: ${value ? 'on' : 'off'}`}
                className={[styles.cloudSwitch, value && styles.cloudSwitchOn].filter(Boolean).join(' ')}
                disabled={pending}
                onClick={flip}
            >
                <svg viewBox="0 0 24 16" aria-hidden="true" className={styles.cloudIcon}>
                    <path d="M19.4 6.6A7 7 0 0 0 6.1 4.8 5 5 0 0 0 5 14.8h14.2a4.1 4.1 0 0 0 .2-8.2Z" />
                </svg>
                {short}
            </button>
            {said && !said.ok && <span className={styles.stateBad}>{said.error}</span>}
        </>
    )
}

const SWITCH_LABELS: Record<SwitchKey, { label: string, short: string }> = {
    websockets: { label: 'WebSockets', short: 'WebSockets' },
    flexibleSsl: { label: 'Cloudflare Flexible SSL', short: 'Flexible' },
}

type ActionProps = {
    id: string
    environment: string
    hostname: string
    // The main address of the environment has no remove button: hostd refuses to remove a primary at all
    // (an environment without one has nothing for its aliases to redirect to), and a button that only
    // ever answers that refusal is worse than no button. Moving it somewhere else is Make primary's job.
    removable: boolean
    // An alias can be made the main address, which swaps it with the current one
    promotable: boolean
    // The environment's main address now, named in the swap dialog. null when it has none.
    primary: string | null
}

export function DomainActions({ id, environment, hostname, removable, promotable, primary }: ActionProps) {
    const router = useRouter()
    const [pending, setPending] = useState<string | null>(null)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    const [asking, setAsking] = useState(false)
    const [promoting, setPromoting] = useState(false)

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
            setPromoting(false)
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

            {promotable && (
                <Button size="small" disabled={pending !== null} onClick={() => setPromoting(true)}>
                    Make primary
                </Button>
            )}

            {removable && (
                <Button size="small" variant="danger" disabled={pending !== null} onClick={() => setAsking(true)}>
                    Remove
                </Button>
            )}

            <Said said={said} />

            <Dialog
                open={promoting}
                onClose={() => setPromoting(false)}
                title="Make this the main address"
                footer={
                    <>
                        <Button variant="quiet" onClick={() => setPromoting(false)}>Leave it</Button>
                        <Button
                            disabled={pending !== null}
                            onClick={() => run('promote', () => makePrimaryDomainAction(id, environment, hostname))}
                        >
                            {pending === 'promote' ? 'Switching...' : 'Make it primary'}
                        </Button>
                    </>
                }
            >
                <p>
                    <span className={styles.mono}>{hostname}</span> becomes this environment&apos;s main
                    address{primary
                        ? <>, and <span className={styles.mono}>{primary}</span> becomes an alias that redirects to it</>
                        : null}. Both keep being served; only the direction of the redirect changes.
                </p>
                <p className={styles.note}>
                    If the site itself redirects to one particular address (a site URL setting in the app),
                    make sure it is this one, or the two redirects will send visitors back and forth.
                </p>
            </Dialog>

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
    // A file Apache lists but cannot open fails its own configuration test, and hostd runs that test
    // before every reload, so this stops the adopt as surely as an unparseable file does. It is not made
    // to block the button, because the operator cannot fix it from this page, only on the server.
    const unreadable = preview?.unreadable ?? []
    const onlyOne = unreadable.length === 1

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
                                    One of the files below does something the configuration hostd writes
                                    cannot do, or uses a directive this parser will not follow. Each
                                    reason is spelled out under the file it came from. hostd refuses the
                                    change rather than replacing the file and hoping, so those have to be
                                    settled by hand on the server first.
                                </Callout>
                            </div>
                        )}

                        {/* Absent from a hostd older than the switch, which reads as off. */}
                        {preview.flexibleSsl && (
                            <div className={styles.said}>
                                <Callout title="Port 80 will keep serving the site (Flexible SSL)">
                                    The file below answers plain HTTP on port 80 and has no port 443 block,
                                    so whatever sits in front of this site (Cloudflare on Flexible) reaches
                                    it over HTTP. Adopting it switches Flexible SSL on for this environment,
                                    so hostd serves the site on port 80 as well, rather than redirecting
                                    it to https and sending that CDN round in a loop. Once the CDN reaches
                                    port 443 instead (Cloudflare: Full), untick Flexible SSL in Settings.
                                </Callout>
                            </div>
                        )}

                        {unreadable.length > 0 && (
                            <div className={styles.said}>
                                <Callout tone="crit" title="Apache cannot read everything in sites-enabled">
                                    {`${unreadable.join(', ')}. Apache lists ${onlyOne ? 'that file' : 'those files'} `
                                        + `but cannot open ${onlyOne ? 'it' : 'them'}, which almost always means a link `
                                        + `pointing at something that has been deleted or renamed. Apache checks its own `
                                        + `configuration before every reload and that check fails while ${onlyOne ? 'it is' : 'they are'} `
                                        + `there, so no domain change on this server, including this one, can take effect `
                                        + `until ${onlyOne ? 'it is' : 'they are'} removed on the server itself.`}
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
                                            {/* Every reason, one per line. A file can be several kinds
                                                of unadoptable at once, and each one is a different edit
                                                the operator has to make, so showing only the first
                                                means being told them one at a time across as many
                                                attempts. */}
                                            {claim.unsupported.map(reason => (
                                                <p className={styles.stateBad} key={reason}>{reason}</p>
                                            ))}
                                            {/* The file itself, whole and unedited. hostd reads a few
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
