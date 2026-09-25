'use client'

// A site's environments, on its Settings tab: every one it has, adding another beside live, deleting one,
// putting a deleted one back within its 30 days, and copying live's data into one. The operator's alone
// end to end: hostd puts all of it under its provision verb, the actions check again, and a client gets
// nothing drawn here at all.

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { LIVE, newEnvironmentProblem } from '@/server/hostd/environmentName'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { DataTable } from '@/ui/DataTable/DataTable'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
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

type Listed = { name: string, branch: string | null, domain: string | null, deployed: string | null }

// The fields of hostd's deleted-environment record this reads. The whole record type lives in
// server/hostd/environments.ts, which a browser component cannot import.
type Deleted = { environment: string, deletedAt: string, purgeAt: string, branch: string | null, domain: string | null }

// One copy run, as the action hands it back
type CopyRun = Extract<CopyRunsResult, { ok: true }>['runs'][number]

type Props = {
    id: string
    // The site's name, which hostd wants typed back to delete an environment, as it does for the site
    name: string
    isAdmin: boolean
    environments: Listed[]
    // The repository's branches, or null when they could not be read, which leaves a text field instead
    branches: string[] | null
    // null when the list could not be read, which deletedError then says in hostd's own words
    deleted: Deleted[] | null
    deletedError: string | null
    // Only for a test to fix the days left against. The page leaves it out.
    now?: Date
}

const ENVIRONMENT_COLUMNS = [
    { key: 'name', head: 'environment' },
    { key: 'branch', head: 'branch' },
    { key: 'domain', head: 'address' },
    { key: 'deployed', head: 'deployed' },
    { key: 'act', head: 'change it' },
]

const DELETED_COLUMNS = [
    { key: 'name', head: 'environment' },
    { key: 'deleted', head: 'deleted' },
    { key: 'left', head: 'purged in' },
    { key: 'act', head: 'change it' },
]

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

export function SiteEnvironments({ id, name, isAdmin, environments, branches, deleted, deletedError, now }: Props) {
    const router = useRouter()
    // Said above the list rather than inside a dialog that has closed by the time it lands
    const [said, setSaid] = useState<SiteActionResult | null>(null)

    if (!isAdmin) return null

    // live first, then the rest in the registry's own order
    const ordered = [...environments.filter(one => one.name === LIVE), ...environments.filter(one => one.name !== LIVE)]

    const rows = ordered.map(environment => ({
        name: <span className={styles.mono}>{environment.name}</span>,
        branch: environment.branch ?? 'no branch',
        domain: environment.domain ? <span className={styles.mono}>{environment.domain}</span> : 'none yet',
        deployed: environment.deployed ? <span className={styles.mono}>{shortCommit(environment.deployed)}</span> : 'not deployed yet',
        act: environment.name === LIVE
            ? null
            // Keyed by name: the table keys rows by position, so without this a row's state (a copy
            // running, a confirm open) would pass to the next environment once one above it is deleted
            : <div key={environment.name} className={styles.environmentActs}>
                <CopyFromLive
                    id={id}
                    environment={environment.name}
                    domain={environment.domain}
                    onStarted={setSaid}
                />
                <DeleteEnvironment
                    id={id}
                    siteName={name}
                    environment={environment.name}
                    onDone={result => { setSaid(result); router.refresh() }}
                />
            </div>,
    }))

    return (
        <div className={styles.environments}>
            <section className={styles.block}>
                <h2>Environments</h2>
                {said && (
                    <div className={styles.said}>
                        {said.ok
                            ? <Callout title="Done">{said.message}</Callout>
                            : <Callout tone="crit" title="That did not happen">{said.error}</Callout>}
                    </div>
                )}
                <DataTable label="Environments" columns={ENVIRONMENT_COLUMNS} rows={rows} />
            </section>

            <AddEnvironment id={id} taken={environments.map(one => one.name)} branches={branches} />

            <section className={styles.block}>
                <h2>Deleted environments</h2>
                {deleted === null
                    ? <p className={styles.note}>{`The deleted environments could not be read: ${deletedError ?? 'hostd did not answer'}`}</p>
                    : <DataTable
                        label="Deleted environments"
                        columns={DELETED_COLUMNS}
                        rows={deleted.map(record => ({
                            name: <span className={styles.mono}>{record.environment}</span>,
                            deleted: dayOf(record.deletedAt),
                            left: daysLeft(record.purgeAt, now ?? new Date()),
                            act: <RestoreEnvironment
                                id={id}
                                environment={record.environment}
                                deletedAt={record.deletedAt}
                                expired={pastPurge(record.purgeAt, now ?? new Date())}
                                onDone={result => { setSaid(result); if (result.ok) router.refresh() }}
                            />,
                        }))}
                        empty="There are no deleted environments."
                    />}
                <p className={styles.note}>
                    A deleted environment is kept for 30 days and can be put back until then. After that its
                    files and volumes are removed for good.
                </p>
            </section>
        </div>
    )
}

function AddEnvironment({ id, taken, branches }: { id: string, taken: string[], branches: string[] | null }) {
    const router = useRouter()
    const [name, setName] = useState('')
    const [branch, setBranch] = useState('')
    const [hostname, setHostname] = useState('')
    const [copyLive, setCopyLive] = useState(false)
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)

    const wanted = name.trim()
    // Checked as it is typed, with the rule hostd uses. hostd still has the final word: only it knows the
    // names deleted in the last 30 days.
    const problem = wanted === ''
        ? null
        : taken.includes(wanted) ? `This site has ${wanted} already.` : newEnvironmentProblem(wanted)
    const ready = wanted !== '' && problem === null && branch.trim() !== '' && !pending

    async function add() {
        setPending(true)
        setSaid(null)
        try {
            const result = await addEnvironmentAction(
                id, wanted, branch.trim(), hostname.trim() === '' ? null : hostname.trim(), copyLive,
            )
            setSaid(result)
            if (result.ok) {
                setName('')
                setBranch('')
                setHostname('')
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
                <Field
                    label="Hostname (optional)"
                    value={hostname}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="uat1.example.com"
                    onChange={event => setHostname(event.target.value)}
                />
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
                started until its first deploy. A hostname can be added later from the Domains tab. A copy
                of live&apos;s data is real client data, and can also be made later from its row above.
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

// What the row says about copies: one going, or how the last one ended
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
// checks that again. hostd answers at once and copies in the background, so the row asks how it is going
// every few seconds while it runs, and stops when it ends or the row goes.
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
