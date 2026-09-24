'use client'

// The editor half of the env panel. Its own file because env.tsx is a server component: it asks hostd for
// the file list and reads the chosen file, neither of which a browser may do.

import { useEffect, useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Field } from '@/ui/Field/Field'
import { saveEnvAction, type SiteActionResult } from './actions'
import styles from './site.module.css'

// Said before it is done, not after. Saving is not a save.
const WHAT_SAVING_DOES =
    'Saving writes the file and restarts the containers. The environment is unavailable for about twenty '
    + 'seconds while they come back, and visitors see the holding page.'

type Props = {
    id: string
    // Which environment's file this is, since every environment has its own
    environment: string
    path: string
    text: string
    example: string | null
}

export function EnvForm({ id, environment, path, text, example }: Props) {
    const [value, setValue] = useState(text)
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)

    // Choosing another file re-renders this with new props rather than remounting it, so the box would
    // otherwise still be holding the previous file's contents under the new file's name.
    useEffect(() => {
        setValue(text)
        setSaid(null)
    }, [path, text])

    async function save() {
        setPending(true)
        setSaid(null)
        try {
            setSaid(await saveEnvAction(id, environment, path, value))
        } catch {
            setSaid({ ok: false, error: 'That did not work. Try reloading the page.' })
        } finally {
            setPending(false)
        }
    }

    return (
        <div className={styles.editor}>
            <Field
                as="textarea"
                label={path}
                rows={18}
                spellCheck={false}
                hint={example ? `There is an example beside it, at ${example}.` : undefined}
                value={value}
                onChange={event => setValue(event.target.value)}
            />

            <p className={styles.note}>{WHAT_SAVING_DOES}</p>

            <div className={styles.save}>
                <Button variant="primary" size="small" disabled={pending || value === text} onClick={save}>
                    {pending ? 'Saving...' : 'Save and restart'}
                </Button>
                {value === text && !pending && <span className={styles.state}>Nothing has been changed.</span>}
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
