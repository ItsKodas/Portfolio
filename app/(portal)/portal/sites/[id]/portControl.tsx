'use client'

// One environment's port. Its own control rather than a field in the Settings save: changing it
// recreates the environment's containers, and nothing else on that form starts or stops anything.

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Field } from '@/ui/Field/Field'
import { usePortCheck } from '../usePortCheck'
import { setPortAction, type SiteActionResult } from './actions'
import styles from './site.module.css'

export function PortControl({ id, environment, port }: { id: string, environment: string, port: number }) {
    const router = useRouter()
    const [value, setValue] = useState(String(port))
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)
    // The port this control treats as already saved. Set from the prop, and ahead of it the moment a
    // change succeeds: router.refresh() is async, so the prop itself does not catch up until the page
    // re-reads, and until then the value just saved must not read as changed again (that would re-enable
    // the button and bring the restart note back beside the success callout it is sitting next to).
    // Re-synced whenever the prop moves, which is what actually happens once the refresh lands.
    const [current, setCurrent] = useState(port)
    useEffect(() => setCurrent(port), [port])

    const trimmed = value.trim()
    const unchanged = trimmed === String(current)
    const inRange = /^\d{1,5}$/.test(trimmed) && Number(trimmed) >= 5000 && Number(trimmed) <= 65535
    const check = usePortCheck(value, { project: id, environment }, { skip: unchanged })
    const problem = unchanged ? null : !inRange ? 'Use a port from 5000 to 65535.' : check.problem

    async function save() {
        setSaid(null)
        setPending(true)
        try {
            const asked = Number(trimmed)
            const result = await setPortAction(id, environment, asked)
            setSaid(result)
            if (result.ok) {
                setCurrent(asked)
                router.refresh()
            }
        } catch {
            setSaid({ ok: false, error: 'That did not work. Try reloading the page.' })
        } finally {
            setPending(false)
        }
    }

    return (
        <div>
            <Field
                label={`${environment} port`}
                inputMode="numeric"
                value={value}
                onChange={event => { setValue(event.target.value); setSaid(null) }}
                error={problem ?? undefined}
                hint={check.error ? `The dedi's ports could not be checked: ${check.error}` : undefined}
            />
            {!unchanged && (
                <p className={styles.note}>
                    Changing it rewrites WEB_PORT in the site's .env, recreates this environment's containers and points its vhost at the new port. The site is down for a few seconds.
                </p>
            )}
            <Button disabled={unchanged || problem !== null || check.checking || pending} onClick={save}>
                {pending ? 'Changing...' : 'Change port'}
            </Button>
            {said && (said.ok
                ? <Callout title="Port changed">{said.message}</Callout>
                : <Callout tone="crit" title="The port was not changed">{said.error}</Callout>)}
        </div>
    )
}
