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
import {
    adoptAction, adoptPreviewAction, addDomainAction, changePrimaryDomainAction, removeDomainAction,
    setPrimaryDomainAction, verifyDomainAction, type SiteActionResult,
} from './actions'
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

// An alias: a name that redirects to the primary. It is rendered whether or not the environment has a
// primary yet, and switched off rather than hidden when it has none. Hiding it is what made this tab look
// as though it could only ever do one of the two jobs, and an operator cannot ask about a control that is
// not on the page. Disabled with the reason beside it says the same thing honestly.
export function AddDomain({ id, environment, disabled = false }: { id: string, environment: string, disabled?: boolean }) {
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
            <h2>Other addresses</h2>
            <div className={styles.addDomain}>
                <Field
                    label="Hostname"
                    value={hostname}
                    disabled={disabled}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="shop.example.com"
                    hint="A name whose DNS already points at this server. hostd checks it before it goes live."
                    onChange={event => setHostname(event.target.value)}
                />
                <div className={styles.addAction}>
                    <Button variant="primary" disabled={disabled || pending || !hostname.trim()} onClick={add}>
                        {pending ? 'Adding...' : 'Add'}
                    </Button>
                    <Said said={said} />
                </div>
            </div>
            <p className={styles.note}>
                {disabled
                    ? 'Set the site\'s address first. Every name added here redirects to it, and there is nothing to redirect to yet.'
                    : 'Each of these redirects to the address above, so the site is only ever reachable at one URL.'}
            </p>
        </section>
    )
}

// The environment's main address, in both of the states it can be in. `current` is null on every site
// that was enrolled by hand, and giving one its first address is safe: nothing is being served from it
// yet, so the write records a name and stops there.
//
// Replacing an address that already exists is the dangerous half, and it is a different interaction
// rather than the same button with a different label: the old name stops being served, the new one has
// to prove itself before it counts, every alias starts redirecting somewhere else and hostd rewrites the
// Apache configuration. So it goes behind the dialog below, which names all four and asks for the new
// hostname back, the same ceremony AdoptSite uses for the other change on this tab that a live site
// notices immediately.
export function PrimaryDomain({ id, environment, current }: { id: string, environment: string, current: string | null }) {
    const router = useRouter()
    const [hostname, setHostname] = useState('')
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    const [asking, setAsking] = useState(false)
    const [typed, setTyped] = useState('')

    const wanted = hostname.trim().toLowerCase()
    // Typed back exactly, because this takes a live site off the address it answers on today
    const named = typed.trim().toLowerCase() === wanted

    async function run(action: () => Promise<SiteActionResult>) {
        setPending(true)
        setSaid(null)
        try {
            const result = await action()
            setSaid(result)
            if (result.ok) {
                setHostname('')
                setTyped('')
                setAsking(false)
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
            <h2>The site&apos;s address</h2>
            <div className={styles.addDomain}>
                <Field
                    label={current ? 'New address' : 'Address'}
                    value={hostname}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="example.com"
                    hint={current
                        ? `This environment answers on ${current} today. What you put here replaces it.`
                        : 'The main name this environment answers to. Other names can be pointed at it afterwards.'}
                    onChange={event => setHostname(event.target.value)}
                />
                <div className={styles.addAction}>
                    {current
                        ? (
                            <Button
                                variant="danger"
                                disabled={pending || wanted === '' || wanted === current}
                                onClick={() => { setTyped(''); setSaid(null); setAsking(true) }}
                            >
                                Change the address
                            </Button>
                        )
                        : (
                            <Button
                                variant="primary"
                                disabled={pending || wanted === ''}
                                onClick={() => run(() => setPrimaryDomainAction(id, environment, wanted))}
                            >
                                {pending ? 'Saving...' : 'Set the address'}
                            </Button>
                        )}
                    <Said said={asking ? null : said} />
                </div>
            </div>
            {!current && (
                <p className={styles.note}>
                    This records the address and changes nothing that is being served: whatever answers
                    this name today keeps answering it. The site is served from it once this environment
                    is adopted, which replaces the hand-written configuration in one reload.
                </p>
            )}

            <Dialog
                open={asking}
                onClose={() => setAsking(false)}
                title="Move this site to another address"
                footer={
                    <>
                        <Button variant="quiet" onClick={() => setAsking(false)}>Leave it where it is</Button>
                        <Button
                            variant="danger"
                            disabled={pending || !named}
                            onClick={() => run(() => changePrimaryDomainAction(id, environment, wanted, typed.trim()))}
                        >
                            {pending ? 'Changing...' : 'Change it'}
                        </Button>
                    </>
                }
            >
                {said && !said.ok && (
                    <div className={styles.said}>
                        <Callout tone="crit" title="That did not happen">{said.error}</Callout>
                    </div>
                )}

                <p>
                    <span className={styles.mono}>{current}</span> becomes{' '}
                    <span className={styles.mono}>{wanted}</span>. Four things follow from that:
                </p>
                <ul>
                    <li>
                        <span className={styles.mono}>{current}</span> stops being served here. Anyone who
                        visits it reaches whatever else answers on this server.
                    </li>
                    <li>
                        <span className={styles.mono}>{wanted}</span> starts unverified. hostd has to reach
                        it and prove it lands on this site before it counts as working, so its DNS needs to
                        point at this server.
                    </li>
                    <li>Every other name on this environment starts redirecting to the new address instead.</li>
                    <li>
                        The Apache configuration for this environment is rewritten and reloaded, if hostd
                        is the one serving it.
                    </li>
                </ul>
                <Field
                    label={`Type ${wanted} to confirm`}
                    value={typed}
                    spellCheck={false}
                    autoComplete="off"
                    hint="Its DNS record is not ours and is left alone, and so is the old name's."
                    onChange={event => setTyped(event.target.value)}
                />
            </Dialog>
        </section>
    )
}

type ActionProps = {
    id: string
    environment: string
    hostname: string
    // The main address of the environment has no remove button: hostd refuses to remove a primary at all
    // (an environment without one has nothing for its aliases to redirect to), and a button that only
    // ever answers that refusal is worse than no button. Moving it somewhere else is PrimaryDomain's job.
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
