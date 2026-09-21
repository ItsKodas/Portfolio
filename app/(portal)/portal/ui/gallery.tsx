'use client'

import { useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Chip } from '@/ui/Chip/Chip'
import { DataTable } from '@/ui/DataTable/DataTable'
import { Dialog } from '@/ui/Dialog/Dialog'
import { Feed } from '@/ui/Feed/Feed'
import { Field } from '@/ui/Field/Field'
import { KeyValue } from '@/ui/KeyValue/KeyValue'
import { LogPane } from '@/ui/LogPane/LogPane'
import { Meter } from '@/ui/Meter/Meter'
import { Row } from '@/ui/Row/Row'
import { StatStrip } from '@/ui/StatStrip/StatStrip'
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

const STATS = [
    { key: 'sites', value: '5', note: 'one down, two flagged' },
    { key: 'deploys this week', value: '12', note: 'all green since Tuesday' },
    { key: 'backup disk', value: '91%', note: 'over the line at 90', tone: 'crit' as const },
    { key: 'oldest backup', value: '14d', note: 'nightly, kept a fortnight' },
]

const PAIRS = [
    { key: 'client', value: 'Marcus Ellery' },
    { key: 'plan', value: 'Managed, annual' },
    { key: 'host', value: 'dedi-01' },
    { key: 'certificate', value: 'expires in 9 days', tone: 'warn' as const },
    { key: 'last backup', value: 'failed on Friday', tone: 'crit' as const },
]

const EVENTS = [
    { time: '21:17', text: 'Deploy started on live' },
    { time: '21:14', text: 'web exited 137', bad: true },
    { time: '20:02', text: 'Nightly backup finished, 1.4 GB' },
    { time: '18:41', text: 'Marcus Ellery signed in' },
]

const LOG = [
    { time: '21:13:58', text: 'Ready on http://0.0.0.0:3000' },
    { time: '21:14:02', text: 'GET / 200 in 41ms' },
    { time: '21:14:11', text: 'exited with code 137', stream: 'err' as const },
    { time: '21:14:12', text: 'restarting (attempt 1 of 3)' },
]

const DEPLOY_COLUMNS = [
    { key: 'commit', head: 'commit' },
    { key: 'message', head: 'message' },
    { key: 'when', head: 'when', numeric: true },
]

const DEPLOY_ROWS = [
    { commit: 'a3f19c2', message: 'Raise the upload limit to 20 MB', when: 'Fri 16:40' },
    { commit: 'd40e7b8', message: 'Fix the contact form reply address', when: 'Thu 11:02' },
    { commit: '2e9d44a', message: 'Swap the hero image', when: 'Tue 09:18' },
]

// The gallery's .items row wraps inline-sized things side by side. A table, a log, a feed and a stat
// strip all want the whole line, and gallery.module.css is not this plan's to edit.
const METER = { width: 240 }
const WIDE = { flex: '1 1 100%', minWidth: 0, display: 'grid', gap: 18 }

function Wide({ children }: { children: React.ReactNode }) {
    return <div style={WIDE}>{children}</div>
}

function Section({ title, note, children }: { title: string, note?: string, children: React.ReactNode }) {
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

            <Section title="Button" note="Tab through these to check the focus ring is visible on all three.">
                <Button variant="primary">Roll back to 2e9d44a</Button>
                <Button>Restart</Button>
                <Button variant="quiet">More</Button>
                <Button disabled>Stop</Button>
                <Button size="small">Build log</Button>
                <Button variant="primary" size="small">Retry</Button>
            </Section>

            <Section title="Field" note="Click each label: the input should take focus.">
                <Field label="Email" name="a" placeholder="you@example.com" />
                <Field label="Email" name="b" hint="We only use this to reply to your enquiry" />
                <Field label="Email" name="c" error="Enter a valid email address" />
                <Field label="Email" name="d" hint="We only use this to reply" error="Enter a valid email address" />
                <Field as="textarea" label="What the client sees" name="e" rows={2} />
            </Section>

            <Section title="Dialog" note="Open it, press Escape, and check focus returns to this button.">
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
            </Section>

            <Section title="Tabs" note="Focus one and use the arrow keys. They should wrap at both ends.">
                <Tabs tabs={TABS} selected={tab} onSelect={setTab} label="Example tools" />
            </Section>

            <Section title="Chip">
                <Chip>nightly</Chip>
                <Chip tone="good">on live now</Chip>
                <Chip tone="warn">not yet</Chip>
                <Chip tone="crit">failed</Chip>
            </Section>

            <Section title="Callout">
                <Callout title="Backups run nightly">At 7 pm, kept for fourteen days.</Callout>
                <Callout tone="warn" title="No offsite backup since Friday">The only copy is on the same disk as the site.</Callout>
                <Callout tone="crit" title="The deploy failed">Live is untouched and still serving a3f19c2.</Callout>
            </Section>

            <Section title="StatusDot" note="The deploying one pulses, unless reduced motion is on.">
                {STATES.map(state => <StatusDot key={state} state={state} />)}
            </Section>

            <Section title="StatusDot, bare" note="Hover one for the word. Tab to the link and the word comes back inline.">
                {STATES.map(state => <StatusDot key={state} state={state} bare />)}
                <a className={styles.bareLink} href="#bare">
                    <StatusDot state="down" bare />
                    <span>a dot inside a link, for the focus behaviour</span>
                </a>
            </Section>

            <Section title="Row" note="The severity rail is the left border. Tab to the clickable one and press Enter.">
                <Wide>
                    <Row title="asot-db" aside="up, mongodb 7.0" meta="14d" />
                    <Row title="ASOT is down" sub="asot.com.au" aside="down" meta="8m" tone="crit" onClick={() => {}} />
                    <Row title="Certificate expires soon" sub="ellery.studio" aside="9 days" meta="9d" tone="warn" />
                    <Row lead={<StatusDot state="deploying" />} title="asot-web" sub="deploying a3f19c2" aside="building" meta="40s" />
                </Wide>
            </Section>

            <Section title="Meter" note="Look for the threshold tick where it crosses the fill, and the clamped one at the end.">
                <div style={METER}><Meter label="Memory" value="19.4 / 32 GB" percent={61} /></div>
                <div style={METER}><Meter label="Backup disk" value="1.31 / 1.44 TB" percent={91} tone="warn" threshold={90} note="over the 90% line" noteTone="warn" /></div>
                <div style={METER}><Meter label="Root disk" value="47 / 220 GB" percent={21} tone="good" /></div>
                <div style={METER}><Meter label="Reported at 104%" value="over" percent={104} tone="crit" /></div>
            </Section>

            <Section title="StatStrip" note="Figures sit between two hairlines rather than in boxes.">
                <Wide>
                    <StatStrip stats={STATS} />
                </Wide>
            </Section>

            <Section title="KeyValue">
                <KeyValue pairs={PAIRS} />
            </Section>

            <Section title="Feed" note="One bad event, carried by its words as well as its colour.">
                <Wide>
                    <Feed events={EVENTS} />
                </Wide>
            </Section>

            <Section title="LogPane" note="Tab into it: the focus ring should be obvious, and the arrow keys should scroll it.">
                <Wide>
                    <LogPane lines={LOG} label="asot-web log" following />
                    <LogPane lines={[]} label="An empty log" />
                </Wide>
            </Section>

            <Section title="DataTable" note="The empty one should read as deliberate, not as a table that failed to load.">
                <Wide>
                    <DataTable label="Deploy history" columns={DEPLOY_COLUMNS} rows={DEPLOY_ROWS} />
                    <DataTable label="An empty deploy history" columns={DEPLOY_COLUMNS} rows={[]} empty="No deploys yet." />
                </Wide>
            </Section>

            <Section title="Icons" note="All 26. Look for one at the wrong weight or the wrong optical size.">
                {Object.entries(icons).map(([name, Icon]) => (
                    <span key={name} className={styles.icon} title={name}><Icon /></span>
                ))}
            </Section>
        </div>
    )
}
