'use client'

import { useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Chip } from '@/ui/Chip/Chip'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Field } from '@/ui/Field/Field'
import { StatusDot } from '@/ui/StatusDot/StatusDot'
import { Tabs } from '@/ui/Tabs/Tabs'
import * as icons from '@/ui/icons'
import styles from './gallery.module.css'

const TABS = [
    { id: 'deploys', label: 'Deploys' },
    { id: 'logs', label: 'Logs' },
    { id: 'env', label: 'Environment' },
]

const STATES = ['up', 'down', 'deploying', 'stopped', 'paused'] as const

function Row({ title, note, children }: { title: string, note?: string, children: React.ReactNode }) {
    return (
        <section className={styles.row}>
            <h2 className={styles.title}>{title}</h2>
            {note && <p className={styles.note}>{note}</p>}
            <div className={styles.items}>{children}</div>
        </section>
    )
}

export default function Gallery() {
    const [tab, setTab] = useState('logs')
    const [open, setOpen] = useState(false)

    return (
        <div className={styles.gallery}>
            <p className={styles.lead}>
                Every component in `ui/`, in every state it has. This page exists to be looked at: if something
                here reads badly, the component is wrong, not the page.
            </p>

            <Row title="Button" note="Tab through these to check the focus ring is visible on all three.">
                <Button variant="primary">Roll back to 2e9d44a</Button>
                <Button>Restart</Button>
                <Button variant="quiet">More</Button>
                <Button disabled>Stop</Button>
                <Button size="small">Build log</Button>
                <Button variant="primary" size="small">Retry</Button>
            </Row>

            <Row title="Field" note="Click each label: the input should take focus.">
                <Field label="Email" name="a" placeholder="you@example.com" />
                <Field label="Email" name="b" hint="We only use this to reply to your enquiry" />
                <Field label="Email" name="c" error="Enter a valid email address" />
                <Field label="Email" name="d" hint="We only use this to reply" error="Enter a valid email address" />
                <Field as="textarea" label="What the client sees" name="e" rows={2} />
            </Row>

            <Row title="Dialog" note="Open it, press Escape, and check focus returns to this button.">
                <Button variant="primary" onClick={() => setOpen(true)}>Open the dialog</Button>
                <Dialog
                    open={open}
                    onClose={() => setOpen(false)}
                    title="Roll back live to d40e7b8?"
                    footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => setOpen(false)}>Roll back live</Button></>}
                >
                    This puts the code back, and nothing else. Anything the database has recorded since Thursday
                    stays exactly as it is.
                </Dialog>
            </Row>

            <Row title="Tabs" note="Focus one and use the arrow keys. They should wrap at both ends.">
                <Tabs tabs={TABS} selected={tab} onSelect={setTab} label="Example tools" />
            </Row>

            <Row title="Chip">
                <Chip>nightly</Chip>
                <Chip tone="good">on live now</Chip>
                <Chip tone="warn">not yet</Chip>
                <Chip tone="crit">failed</Chip>
            </Row>

            <Row title="Callout">
                <Callout title="Backups run nightly">At 7 pm, kept for fourteen days.</Callout>
                <Callout tone="warn" title="No offsite backup since Friday">The only copy is on the same disk as the site.</Callout>
                <Callout tone="crit" title="The deploy failed">Live is untouched and still serving a3f19c2.</Callout>
            </Row>

            <Row title="StatusDot" note="The deploying one pulses, unless reduced motion is on.">
                {STATES.map(state => <StatusDot key={state} state={state} />)}
            </Row>

            <Row title="Icons" note="All 26. Look for one at the wrong weight or the wrong optical size.">
                {Object.entries(icons).map(([name, Icon]) => (
                    <span key={name} className={styles.icon} title={name}><Icon /></span>
                ))}
            </Row>
        </div>
    )
}
