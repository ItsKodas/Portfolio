'use client'

// The client pieces of a site's Environments tab: one environment's Summary, with copying live's data into
// it and deleting it; the environments deleted in the last 30 days, under the list, each with its Restore;
// and the form that adds another beside live. Adding, deleting, restoring and copying are the operator's
// alone end to end: hostd puts all of it under its provision verb, the actions check again, and a client
// gets none of it drawn.

import { useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

import { addressBases, HORIZONS_BASE, isAddressLabel, prefilledPrefix } from '@/server/hostd/environmentAddress'
import { LIVE, newEnvironmentProblem } from '@/server/hostd/environmentName'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { KeyValue } from '@/ui/KeyValue/KeyValue'
import {
    addEnvironmentAction, copyFromLiveAction, copyRunsAction, deleteEnvironmentAction, restoreEnvironmentAction,
    type CopyRunsResult, type SiteActionResult,
} from './actions'
import { shortCommit } from './deploys'
import { formatDay } from '../../format'
import styles from './site.module.css'

const BROKE = 'That did not work. Try reloading the page.'
const DAY_MS = 24 * 60 * 60_000
// How often a running copy is asked about. A copy takes minutes, so this is plenty.
const POLL_MS = 3000

type Listed = { name: string, branch: string | null, domain: string | null, deployed: string | null, port?: number }

// The fields of hostd's deleted-environment record this reads. The whole record type lives in
// server/hostd/environments.ts, which a browser component cannot import.
type Deleted = { environment: string, deletedAt: string, purgeAt: string, branch: string | null, domain: string | null }

// One copy run, as the action hands it back
type CopyRun = Extract<CopyRunsResult, { ok: true }>['runs'][number]

// What the last delete, restore or copy said, shown at the top of the tab. Held above the Summary rather
// than in it: deleting an environment takes the tab back to live, which unmounts that environment's
// Summary, and what hostd said about the delete has to outlive it.
const SaidContext = createContext<(said: SiteActionResult) => void>(() => {})

export function EnvironmentsSaid({ children }: { children: ReactNode }) {
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    return (
        <SaidContext.Provider value={setSaid}>
            {said && (
                <div className={styles.said}>
                    {said.ok
                        ? <Callout title="Done">{said.message}</Callout>
                        : <Callout tone="crit" title="That did not happen">{said.error}</Callout>}
                </div>
            )}
            {children}
        </SaidContext.Provider>
    )
}

// What a small action said, beside the thing that caused it
function Said({ said }: { said: SiteActionResult | null }) {
    if (!said) return null
    return said.ok
        ? <span className={styles.state}>{said.message}</span>
        : <span className={styles.stateBad}>{said.error}</span>
}

function daysLeft(purgeAt: string, now: Date): string {
    const days = Math.ceil((new Date(purgeAt).getTime() - now.getTime()) / DAY_MS)
    if (!Number.isFinite(days)) return purgeAt
    // hostd sweeps every hour, so one past its date is still listed until the next sweep
    if (days <= 0) return 'due to be purged'
    return days === 1 ? '1 day left' : `${days} days left`
}

// hostd refuses a restore once the 30 days are up, and its next sweep purges the environment
function pastPurge(purgeAt: string, now: Date): boolean {
    return new Date(purgeAt).getTime() <= now.getTime()
}

function dayOf(iso: string): string {
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? iso : formatDay(at)
}

type SummaryProps = {
    id: string
    // The site's name, which hostd wants typed back to delete an environment, as it does for the site
    siteName: string
    isAdmin: boolean
    environment: Listed
}

// Keyed on the environment's name here rather than trusted to every caller: choosing another environment
// navigates to this same route, which rerenders rather than remounts, and a running copy or an open
// confirm must not pass from one environment to the next.
export function EnvironmentSummary(props: SummaryProps) {
    return <SummaryOf key={props.environment.name} {...props} />
}

function SummaryOf({ id, siteName, isAdmin, environment }: SummaryProps) {
    const router = useRouter()
    const say = useContext(SaidContext)

    const pairs = [
        { key: 'branch', value: environment.branch ?? 'no branch' },
        {
            key: 'deployed',
            value: environment.deployed
                ? <span className={styles.mono}>{shortCommit(environment.deployed)}</span>
                : 'not deployed yet',
        },
        // The port is how the operator reaches it on the dedi, which is nothing a client needs
        ...(isAdmin && environment.port !== undefined
            ? [{ key: 'port', value: <span className={styles.mono}>{String(environment.port)}</span> }]
            : []),
    ]

    return (
        <section className={styles.block} aria-labelledby="summary">
            <h2 id="summary">Summary</h2>
            <KeyValue pairs={pairs} />
            {isAdmin && environment.name !== LIVE && (
                <div className={`${styles.environmentActs} ${styles.summaryActs}`}>
                    <CopyFromLive
                        id={id}
                        environment={environment.name}
                        domain={environment.domain}
                        onStarted={say}
                    />
                    <DeleteEnvironment
                        id={id}
                        siteName={siteName}
                        environment={environment.name}
                        onDone={result => {
                            say(result)
                            // It is gone, so the tab goes back to live, which also reads the list again
                            router.push(`/portal/sites/${id}?tab=environments`, { scroll: false })
                        }}
                    />
                </div>
            )}
        </section>
    )
}

type DeletedProps = {
    id: string
    // null when the list could not be read, which deletedError then says in hostd's own words
    deleted: Deleted[] | null
    deletedError: string | null
    // Only for a test to fix the days left against. The page leaves it out.
    now?: Date
}

// Under the list of environments, narrow, so a list of lines rather than a table
export function DeletedEnvironments({ id, deleted, deletedError, now }: DeletedProps) {
    const router = useRouter()
    const say = useContext(SaidContext)
    const at = now ?? new Date()

    return (
        <section className={styles.deleted} aria-labelledby="deleted-environments">
            <h2 id="deleted-environments">Deleted environments</h2>
            {deleted === null
                ? <p className={styles.note}>{`The deleted environments could not be read: ${deletedError ?? 'hostd did not answer'}`}</p>
                : deleted.length === 0
                    ? <p className={styles.empty}>There are no deleted environments.</p>
                    : <ul className={styles.deletedList} aria-label="Deleted environments">
                        {deleted.map(record => (
                            <li className={styles.deletedItem} key={`${record.environment}-${record.deletedAt}`}>
                                <span className={styles.mono}>{record.environment}</span>
                                <span className={styles.state}>
                                    {`Deleted ${dayOf(record.deletedAt)}, ${daysLeft(record.purgeAt, at)}`}
                                </span>
                                <RestoreEnvironment
                                    id={id}
                                    environment={record.environment}
                                    deletedAt={record.deletedAt}
                                    expired={pastPurge(record.purgeAt, at)}
                                    onDone={result => { say(result); if (result.ok) router.refresh() }}
                                />
                            </li>
                        ))}
                    </ul>}
            <p className={styles.note}>
                A deleted environment is kept for 30 days and can be put back until then. After that its
                files and volumes are removed for good.
            </p>
        </section>
    )
}

type AddProps = {
    id: string
    taken: string[]
    branches: string[] | null
    // live's primary domain as the page read it, offered as a base beside horizons.gg. null when live has
    // none. Only an offer: the action checks the base again against hostd's current value.
    primaryDomain: string | null
}

// Opened in the detail area by the list's Add environment
export function AddEnvironment({ id, taken, branches, primaryDomain }: AddProps) {
    const router = useRouter()
    const [name, setName] = useState('')
    const [branch, setBranch] = useState('')
    const [base, setBase] = useState(HORIZONS_BASE)
    // The prefix follows the name and the base until it is edited by hand, and is the typed value after
    const [typedPrefix, setTypedPrefix] = useState('')
    const [touched, setTouched] = useState(false)
    const [copyLive, setCopyLive] = useState(false)
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)

    const wanted = name.trim()
    // Checked as it is typed, with the rule hostd uses. hostd still has the final word: only it knows the
    // names deleted in the last 30 days.
    const problem = wanted === ''
        ? null
        : taken.includes(wanted) ? `This site has ${wanted} already.` : newEnvironmentProblem(wanted)

    const bases = addressBases(primaryDomain)
    // A primary domain that went away on a refresh leaves horizons.gg chosen rather than a base on offer
    // nowhere
    const chosenBase = bases.includes(base) ? base : HORIZONS_BASE
    const prefix = touched ? typedPrefix : prefilledPrefix(wanted, id, chosenBase)
    const prefixProblem = prefix === '' || isAddressLabel(prefix)
        ? null
        : 'Use one name of lowercase letters, digits and hyphens, with no dots, not starting or ending with a hyphen.'
    const hostname = `${prefix}.${chosenBase}`

    const ready = wanted !== '' && problem === null && branch.trim() !== '' && prefix !== '' && prefixProblem === null && !pending

    async function add() {
        setPending(true)
        setSaid(null)
        try {
            const result = await addEnvironmentAction(id, wanted, branch.trim(), hostname, copyLive)
            setSaid(result)
            if (result.ok) {
                setName('')
                setBranch('')
                setBase(HORIZONS_BASE)
                setTypedPrefix('')
                setTouched(false)
                setCopyLive(false)
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
            <h2>Add an environment</h2>
            <div className={styles.addEnvironment}>
                <Field
                    label="Name"
                    value={name}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="uat1"
                    error={problem ?? undefined}
                    onChange={event => setName(event.target.value)}
                />
                {branches ? (
                    <Field as="select" label="Branch" value={branch} onChange={event => setBranch(event.target.value)}>
                        <option value="">Choose a branch</option>
                        {branches.map(one => <option key={one} value={one}>{one}</option>)}
                    </Field>
                ) : (
                    <Field label="Branch" value={branch} spellCheck={false} onChange={event => setBranch(event.target.value)} />
                )}
            </div>
            <div className={`${styles.addEnvironment} ${styles.addAddress}`}>
                <Field
                    label="Prefix"
                    value={prefix}
                    spellCheck={false}
                    autoComplete="off"
                    error={prefixProblem ?? undefined}
                    onChange={event => {
                        setTypedPrefix(event.target.value)
                        setTouched(true)
                    }}
                />
                <Field as="select" label="Base" value={chosenBase} onChange={event => setBase(event.target.value)}>
                    {bases.map(one => <option key={one} value={one}>{one}</option>)}
                </Field>
            </div>
            <div className={styles.addressHelp}>
                {prefix !== '' && (
                    <p className={styles.note}>
                        Address: <span className={styles.addressName}>{hostname}</span>
                    </p>
                )}
                <p className={styles.note}>
                    Point this name at the dedi in DNS first. hostd does not create DNS records.
                </p>
            </div>
            <label className={styles.capability}>
                <input type="checkbox" checked={copyLive} onChange={event => setCopyLive(event.target.checked)} />
                Start with a copy of live&apos;s data
            </label>
            <div className={styles.save}>
                <Button variant="primary" disabled={!ready} onClick={add}>
                    {pending ? 'Adding...' : 'Add environment'}
                </Button>
                <Said said={said} />
            </div>
            <p className={styles.note}>
                It gets its own folder, port and database, with a copy of live&apos;s env files. It is not
                started until its first deploy. More names can be added later from its Domains section. A
                copy of live&apos;s data is real client data, and can also be made later from its Summary.
            </p>
        </section>
    )
}

function DeleteEnvironment({ id, siteName, environment, onDone }: {
    id: string
    siteName: string
    environment: string
    onDone: (result: SiteActionResult) => void
}) {
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
            const result = await deleteEnvironmentAction(id, environment, typed.trim())
            if (result.ok) {
                setOpen(false)
                onDone(result)
            } else {
                setError(result.error)
            }
        } catch {
            setError(BROKE)
        }
        setPending(false)
    }

    // Typed back exactly, because hostd compares it exactly
    const ready = typed.trim() === siteName && !pending

    return (
        <>
            <Button size="small" variant="danger" aria-label={`Delete ${environment}`} onClick={show}>Delete</Button>
            <Dialog
                open={open}
                onClose={() => { if (!pending) setOpen(false) }}
                title={`Delete ${environment}`}
                footer={
                    <>
                        <Button variant="quiet" disabled={pending} onClick={() => setOpen(false)}>Keep it</Button>
                        <Button variant="danger" disabled={!ready} onClick={go}>
                            {pending ? 'Deleting...' : 'Delete environment'}
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
                    {`${environment} is stopped and taken off the web, and its files are moved aside. They are `
                        + `kept for 30 days, and it can be restored from this tab until then. After that its files `
                        + `and volumes are removed for good. live is not touched.`}
                </p>
                <Field
                    label={`Type ${siteName} to confirm`}
                    value={typed}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={event => setTyped(event.target.value)}
                />
            </Dialog>
        </>
    )
}

function RestoreEnvironment({ id, environment, deletedAt, expired, onDone }: {
    id: string
    environment: string
    deletedAt: string
    // Past its purge date: hostd would only refuse it
    expired: boolean
    onDone: (result: SiteActionResult) => void
}) {
    const [pending, setPending] = useState(false)

    async function restore() {
        setPending(true)
        try {
            onDone(await restoreEnvironmentAction(id, environment, deletedAt))
        } catch {
            onDone({ ok: false, error: BROKE })
        } finally {
            setPending(false)
        }
    }

    return (
        <>
            <Button size="small" disabled={pending || expired} aria-label={`Restore ${environment}`} onClick={restore}>
                {pending ? 'Restoring...' : 'Restore'}
            </Button>
            {expired && <span className={styles.note}>It is past its 30 days, so it can no longer be restored.</span>}
        </>
    )
}

// The newest run, whatever order hostd listed them in
function latestOf(runs: CopyRun[]): CopyRun | null {
    return runs.reduce<CopyRun | null>((latest, run) => (latest === null || run.startedAt > latest.startedAt ? run : latest), null)
}

// What the Summary says about copies: one going, or how the last one ended
function CopyState({ latest, running, trouble }: { latest: CopyRun | null, running: boolean, trouble: string | null }) {
    if (trouble) return <span className={styles.stateBad}>{`The copies could not be read: ${trouble}`}</span>
    if (running) return <span className={styles.state}>Copying from live...</span>
    if (!latest) return null
    if (latest.outcome === 'ok') return <span className={styles.state}>{`Copied from live on ${dayOf(latest.startedAt)}.`}</span>
    if (latest.outcome === 'failed') {
        const where = latest.step ? ` at ${latest.step}` : ''
        const why = latest.reason ? `: ${latest.reason.replace(/\.+$/, '')}` : ''
        // hostd's reason already says so for a failed load, sqlite or storage step, and nothing was written
        // into the environment before those. A run with no step is one the agent restarted during, which
        // may have got anywhere.
        const partly = latest.step === null ? ' It may be partly copied, and a new copy overwrites it.' : ''
        return <span className={styles.stateBad}>{`The copy from live failed${where}${why}.${partly}`}</span>
    }
    return null
}

// Copying live's databases and storage over this environment's. Real client data going somewhere less
// guarded than live, so the dialog says so and wants the environment's name typed back, and the action
// checks that again. hostd answers at once and copies in the background, so the Summary asks how it is
// going every few seconds while it runs, and stops when it ends or the Summary goes.
function CopyFromLive({ id, environment, domain, onStarted }: {
    id: string
    environment: string
    domain: string | null
    onStarted: (result: SiteActionResult) => void
}) {
    const [open, setOpen] = useState(false)
    const [typed, setTyped] = useState('')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [latest, setLatest] = useState<CopyRun | null>(null)
    const [running, setRunning] = useState(false)
    const [trouble, setTrouble] = useState<string | null>(null)
    // Bumped when a copy starts, which reads the runs again and so starts the polling
    const [check, setCheck] = useState(0)

    useEffect(() => {
        let alive = true
        let timer: ReturnType<typeof setTimeout> | undefined
        async function read() {
            try {
                const result = await copyRunsAction(id, environment)
                if (!alive) return
                // A failed read ends the watching, so the button is handed back rather than left disabled
                if (!result.ok) {
                    setTrouble(result.error)
                    setRunning(false)
                    return
                }
                setTrouble(null)
                setLatest(latestOf(result.runs))
                setRunning(result.running)
                if (result.running) timer = setTimeout(read, POLL_MS)
            } catch {
                if (alive) {
                    setTrouble(BROKE)
                    setRunning(false)
                }
            }
        }
        read()
        return () => {
            alive = false
            if (timer) clearTimeout(timer)
        }
    }, [id, environment, check])

    function show() {
        setTyped('')
        setError(null)
        setOpen(true)
    }

    async function go() {
        setPending(true)
        setError(null)
        try {
            const result = await copyFromLiveAction(id, environment, typed.trim())
            if (result.ok) {
                setOpen(false)
                setRunning(true)
                setCheck(count => count + 1)
                onStarted({ ok: true, message: result.message })
            } else {
                setError(result.error)
            }
        } catch {
            setError(BROKE)
        }
        setPending(false)
    }

    // Typed back exactly, because the action compares it exactly
    const ready = typed.trim() === environment && !pending

    return (
        <>
            <Button
                size="small"
                disabled={running}
                aria-label={`Copy data from live into ${environment}`}
                onClick={show}
            >
                Copy data from live
            </Button>
            <CopyState latest={latest} running={running} trouble={trouble} />
            <Dialog
                open={open}
                onClose={() => { if (!pending) setOpen(false) }}
                title={`Copy live's data into ${environment}`}
                footer={
                    <>
                        <Button variant="quiet" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
                        <Button variant="danger" disabled={!ready} onClick={go}>
                            {pending ? 'Starting...' : 'Copy data'}
                        </Button>
                    </>
                }
            >
                {error && (
                    <div className={styles.said}>
                        <Callout tone="crit" title="The copy did not start">{error}</Callout>
                    </div>
                )}
                <p className={styles.note}>
                    {`${environment}'s databases and storage are replaced with live's current data. What `
                        + `${environment} holds now is lost. live keeps running and is not changed.`}
                </p>
                <p className={styles.note}>
                    {'This is real client data. '
                        + (domain
                            ? `It may be reachable at ${domain}, so treat ${environment} with the same care as live.`
                            : `It may be reachable at any hostname ${environment} is given, so treat it with the same care as live.`)}
                </p>
                <Field
                    label={`Type ${environment} to confirm`}
                    value={typed}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={event => setTyped(event.target.value)}
                />
            </Dialog>
        </>
    )
}
