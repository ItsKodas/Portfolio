# Portal components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the components the `/portal` screens need and `ui/` does not yet have, so the pages become arrangement rather than invention.

**Architecture:** More folders under `ui/`, in the shape the eight existing components already use: one folder each holding the component, its CSS module and its test. Every colour comes from a token. Each component's accessibility obligations are tests, because those failures are silent.

**Tech Stack:** TypeScript, React 18, Next.js 15 App Router, CSS modules, vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-20-ui-library-design.md`, and the design these serve is the Readout three-zone mockup at https://claude.ai/artifact/XLHxrDVisXjvGYTC5Xto3M

## Global Constraints

- **No em dashes** (U+2014) anywhere: code comments are the only exception, per `CLAUDE.md`.
- **House style:** four-space indent, no semicolons, single quotes, named exports.
- Nothing in `ui/` imports from `server/` or from MUI.
- **Every colour is a token.** A hex inside a component stylesheet is a bug, except inside `rgba()` alpha values, which the existing components already use.
- **Do not add, rename or change a token.** Another session is retinting `ui/tokens.*` from the night navy to Readout while this plan runs. Use the existing names. If a component genuinely needs a token that does not exist, stop and report it rather than adding one. Note that `deep` and `panel` may hold the same value in the new palette; that is deliberate, not a mistake to fix.
- Do not touch `ui/tokens.css`, `ui/tokens.ts`, `ui/tokens.test.ts`, `server/`, `hostd/` or the root `package.json`. Add no dependency.
- Do not build a page. This plan produces components only.
- Tests run with `npx vitest run`. The `ui` project already covers `ui/**/*.test.tsx` in jsdom.

## What already exists, and must not be rebuilt

`Button`, `Field`, `Dialog`, `Tabs`, `Chip`, `Callout`, `StatusDot` and the 26 icons. Use them. `Tabs` in particular already does roving tabindex and arrow keys, so the site page's tab strip is `Tabs` and not a new component.

## What jsdom cannot tell you

Two obligations in this plan have no test, and are listed as gallery checks instead. Saying so here so their absence is not read as an oversight:

- **The rail must never be `display: none` at any width.** jsdom applies no media queries and computes no layout, so nothing can assert it. It is the single most important rule in `Shell`, because hiding the rail loses content rather than adapting to it. It is checked by eye.
- **Whether a colour is legible** on the new palette. Contrast ratios changed with the retint.

---

### Task 1: Row

The workhorse. Alerts, sites, containers, backups, updates and downloads are all this component.

**Files:**
- Create: `ui/Row/Row.tsx`, `ui/Row/Row.module.css`
- Test: `ui/Row/Row.test.tsx`

**Interfaces:**
- Produces: `Row`, props `{ tone?: 'crit' | 'warn', onClick?: () => void, lead?: ReactNode, title: ReactNode, sub?: ReactNode, aside?: ReactNode, meta?: ReactNode }`

- [ ] **Step 1: Write the failing test**

Create `ui/Row/Row.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Row } from './Row'

describe('Row', () => {
    it('is a plain element when it does nothing', () => {
        render(<Row title="asot-db" aside="up, mongodb 7.0" />)
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
        expect(screen.getByText('asot-db')).toBeInTheDocument()
    })

    it('is a real button when it does something, so the keyboard reaches it', async () => {
        const onClick = vi.fn()
        render(<Row title="ASOT is down" onClick={onClick} />)
        const row = screen.getByRole('button', { name: /ASOT is down/ })
        row.focus()
        await userEvent.keyboard('{Enter}')
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('puts every part into the accessible name of a clickable row', () => {
        render(<Row title="ASOT" sub="asot.com.au" aside="down" meta="8m" onClick={() => {}} />)
        // A row read out as "ASOT" alone tells a screen reader user nothing about why it matters
        expect(screen.getByRole('button')).toHaveAccessibleName('ASOT asot.com.au down 8m')
    })

    it('carries its tone as a class rather than as the only signal', () => {
        const { container } = render(<Row title="ASOT is down" tone="crit" aside="down" />)
        expect(container.firstElementChild?.className).toMatch(/crit/)
        // the word is present too, so colour is never doing the work alone
        expect(screen.getByText('down')).toBeInTheDocument()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/Row/Row.test.tsx`
Expected: FAIL, cannot resolve `./Row`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/Row/Row.module.css`:

```css
.row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 9px 0 9px 11px;
    border-bottom: 1px solid var(--rule);
    border-left: 2px solid transparent;
    font-size: 13.5px;
    text-align: left;
    background: none;
}

button.row { cursor: pointer; }
button.row:hover { background: rgba(255, 255, 255, .025); }
button.row:focus-visible { outline: 2px solid var(--lake); outline-offset: -2px; }

.crit { border-left-color: var(--crit); }
.warn { border-left-color: var(--warn); }

.grow { flex: 1 1 auto; min-width: 0; }
.title { font-weight: 500; }
.sub { font-family: var(--font-mono), monospace; font-size: 11px; color: var(--ink-3); margin-top: 1px; display: block; }
.aside { font-size: 12.5px; color: var(--ink-2); flex: none; }
.meta { font-family: var(--font-mono), monospace; font-size: 11.5px; color: var(--ink-3);
    width: 58px; text-align: right; flex: none; font-variant-numeric: tabular-nums; }
.lead { flex: none; display: flex; align-items: center; }
```

- [ ] **Step 4: Write the component**

Create `ui/Row/Row.tsx`:

```tsx
import type { ReactNode } from 'react'

import styles from './Row.module.css'

type Props = {
    tone?: 'crit' | 'warn'
    onClick?: () => void
    lead?: ReactNode
    title: ReactNode
    sub?: ReactNode
    aside?: ReactNode
    meta?: ReactNode
}

export function Row({ tone, onClick, lead, title, sub, aside, meta }: Props) {
    const classes = [styles.row, tone && styles[tone]].filter(Boolean).join(' ')
    const inner = (
        <>
            {lead && <span className={styles.lead}>{lead}</span>}
            <span className={styles.grow}>
                <span className={styles.title}>{title}</span>
                {sub && <span className={styles.sub}>{sub}</span>}
            </span>
            {aside && <span className={styles.aside}>{aside}</span>}
            {meta && <span className={styles.meta}>{meta}</span>}
        </>
    )

    // A div with a click handler is unreachable by keyboard and invisible to a screen reader. A row that
    // does something is a button; a row that does not is not pretending to be one.
    if (!onClick) return <div className={classes}>{inner}</div>
    return <button type="button" className={classes} onClick={onClick}>{inner}</button>
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/Row/Row.test.tsx`
Expected: PASS, four tests.

- [ ] **Step 6: Commit**

```bash
git add ui/Row
git commit -m "Add the Row component"
```

---

### Task 2: Meter

**Files:**
- Create: `ui/Meter/Meter.tsx`, `ui/Meter/Meter.module.css`
- Test: `ui/Meter/Meter.test.tsx`

**Interfaces:**
- Produces: `Meter`, props `{ label: string, value: string, percent: number, tone?: 'good' | 'warn' | 'crit', threshold?: number, note?: string, noteTone?: 'warn' }`

- [ ] **Step 1: Write the failing test**

Create `ui/Meter/Meter.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Meter } from './Meter'

describe('Meter', () => {
    it('reads out as its label and its value, not as a bar', () => {
        render(<Meter label="Backup disk" value="1.31 / 1.44 TB" percent={91} tone="warn" />)
        expect(screen.getByText('Backup disk')).toBeInTheDocument()
        expect(screen.getByText('1.31 / 1.44 TB')).toBeInTheDocument()
    })

    it('hides the bar itself, because the value beside it already says everything', () => {
        const { container } = render(<Meter label="Memory" value="19.4 / 32 GB" percent={61} />)
        expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })

    it('clamps a percentage that arrives outside nought to a hundred', () => {
        // A disk that reports 104% should draw a full bar, not one that overflows its track
        const { container } = render(<Meter label="Disk" value="over" percent={104} />)
        const fill = container.querySelector('[data-fill]') as HTMLElement
        expect(fill.style.width).toBe('100%')
    })

    it('shows a note when there is one, so a threshold can explain itself', () => {
        render(<Meter label="Backup disk" value="91%" percent={91} threshold={90} note="over the 90% line" noteTone="warn" />)
        expect(screen.getByText('over the 90% line')).toBeInTheDocument()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/Meter/Meter.test.tsx`
Expected: FAIL, cannot resolve `./Meter`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/Meter/Meter.module.css`:

```css
.meter { display: block; }

.label { display: flex; align-items: baseline; gap: 9px; font-size: 12px; margin-bottom: 5px; }
.name { color: var(--ink-2); }
.value {
    margin-left: auto;
    font-family: var(--font-mono), monospace;
    color: var(--ink);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
}

.track {
    position: relative;
    height: 5px;
    border: 1px solid var(--rule);
    border-radius: 3px;
    background: var(--night);
}
.fill { position: absolute; inset: 0 auto 0 0; border-radius: 2px; background: var(--ink-3); }
.fill.good { background: var(--good); }
.fill.warn { background: var(--warn); }
.fill.crit { background: var(--crit); }

.tick { position: absolute; top: -3px; bottom: -3px; width: 1px; background: var(--ink-3); }

.note { font-size: 10.5px; color: var(--ink-3); margin-top: 4px; }
.note.warn { color: var(--warn); }
```

- [ ] **Step 4: Write the component**

Create `ui/Meter/Meter.tsx`:

```tsx
import styles from './Meter.module.css'

type Props = {
    label: string
    value: string
    percent: number
    tone?: 'good' | 'warn' | 'crit'
    threshold?: number
    note?: string
    noteTone?: 'warn'
}

const clamp = (n: number) => Math.max(0, Math.min(100, n))

export function Meter({ label, value, percent, tone, threshold, note, noteTone }: Props) {
    return (
        <div className={styles.meter}>
            <div className={styles.label}>
                <span className={styles.name}>{label}</span>
                <span className={styles.value}>{value}</span>
            </div>
            {/* The bar is a picture of the number printed beside it, so it is hidden rather than
                described twice. */}
            <div className={styles.track} aria-hidden="true">
                <span
                    data-fill
                    className={[styles.fill, tone && styles[tone]].filter(Boolean).join(' ')}
                    style={{ width: `${clamp(percent)}%` }}
                />
                {threshold !== undefined && <span className={styles.tick} style={{ left: `${clamp(threshold)}%` }} />}
            </div>
            {note && <div className={[styles.note, noteTone && styles[noteTone]].filter(Boolean).join(' ')}>{note}</div>}
        </div>
    )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/Meter/Meter.test.tsx`
Expected: PASS, four tests.

- [ ] **Step 6: Commit**

```bash
git add ui/Meter
git commit -m "Add the Meter component"
```

---

### Task 3: StatStrip

The row of figures under the greeting, divided by a rule above and below rather than sitting in boxes.

**Files:**
- Create: `ui/StatStrip/StatStrip.tsx`, `ui/StatStrip/StatStrip.module.css`
- Test: `ui/StatStrip/StatStrip.test.tsx`

**Interfaces:**
- Produces: `StatStrip`, props `{ stats: { key: string, value: string, note?: string, tone?: 'good' | 'warn' | 'crit' }[] }`

- [ ] **Step 1: Write the failing test**

Create `ui/StatStrip/StatStrip.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatStrip } from './StatStrip'

const stats = [
    { key: 'sites', value: '5', note: 'one down, two flagged' },
    { key: 'backup disk', value: '91%', note: 'over the line at 90', tone: 'crit' as const },
]

describe('StatStrip', () => {
    it('pairs every figure with what it counts', () => {
        render(<StatStrip stats={stats} />)
        // A list of bare numbers is not information; each one is a term and its description
        expect(screen.getByText('sites')).toBeInTheDocument()
        expect(screen.getByText('5')).toBeInTheDocument()
        expect(screen.getByText('91%')).toBeInTheDocument()
    })

    it('is a description list, so the pairing survives without the layout', () => {
        const { container } = render(<StatStrip stats={stats} />)
        expect(container.querySelector('dl')).toBeInTheDocument()
        expect(container.querySelectorAll('dt')).toHaveLength(2)
    })

    it('renders nothing at all rather than an empty rule when given no figures', () => {
        const { container } = render(<StatStrip stats={[]} />)
        expect(container).toBeEmptyDOMElement()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/StatStrip/StatStrip.test.tsx`
Expected: FAIL, cannot resolve `./StatStrip`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/StatStrip/StatStrip.module.css`:

```css
.strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(122px, 1fr));
    border-block: 1px solid var(--rule);
    padding-block: 12px;
    margin: 0;
}

.stat { padding-right: 16px; }
.key { color: var(--ink-3); font-size: 10.5px; }
.value {
    margin: 2px 0 0;
    font-family: var(--font-mono), monospace;
    font-size: 19px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
}
.value.good { color: var(--good); }
.value.warn { color: var(--warn); }
.value.crit { color: var(--crit); }
.note { color: var(--ink-3); font-size: 10px; margin-top: 1px; }
```

- [ ] **Step 4: Write the component**

Create `ui/StatStrip/StatStrip.tsx`:

```tsx
import styles from './StatStrip.module.css'

type Stat = {
    key: string
    value: string
    note?: string
    tone?: 'good' | 'warn' | 'crit'
}

export function StatStrip({ stats }: { stats: Stat[] }) {
    // An empty strip is two hairlines with nothing between them, which reads as a bug
    if (!stats.length) return null
    return (
        <dl className={styles.strip}>
            {stats.map(stat => (
                <div className={styles.stat} key={stat.key}>
                    <dt className={styles.key}>{stat.key}</dt>
                    <dd className={[styles.value, stat.tone && styles[stat.tone]].filter(Boolean).join(' ')}>
                        {stat.value}
                    </dd>
                    {stat.note && <dd className={styles.note}>{stat.note}</dd>}
                </div>
            ))}
        </dl>
    )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/StatStrip/StatStrip.test.tsx`
Expected: PASS, three tests.

- [ ] **Step 6: Commit**

```bash
git add ui/StatStrip
git commit -m "Add the StatStrip component"
```

---

### Task 4: KeyValue and Feed

Two small ones. `KeyValue` is the facts list in the rail; `Feed` is the activity list.

**Files:**
- Create: `ui/KeyValue/KeyValue.tsx`, `ui/KeyValue/KeyValue.module.css`, `ui/Feed/Feed.tsx`, `ui/Feed/Feed.module.css`
- Test: `ui/KeyValue/KeyValue.test.tsx`, `ui/Feed/Feed.test.tsx`

**Interfaces:**
- Produces: `KeyValue`, props `{ pairs: { key: string, value: ReactNode, tone?: 'warn' | 'crit' }[] }`; `Feed`, props `{ events: { time: string, text: ReactNode, bad?: boolean }[] }`

- [ ] **Step 1: Write the failing tests**

Create `ui/KeyValue/KeyValue.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { KeyValue } from './KeyValue'

describe('KeyValue', () => {
    it('is a description list, so each value stays tied to its key', () => {
        const { container } = render(<KeyValue pairs={[{ key: 'client', value: 'Marcus Ellery' }]} />)
        expect(container.querySelector('dl')).toBeInTheDocument()
        expect(screen.getByText('client').tagName).toBe('DT')
        expect(screen.getByText('Marcus Ellery').tagName).toBe('DD')
    })

    it('renders nothing when there is nothing to say', () => {
        const { container } = render(<KeyValue pairs={[]} />)
        expect(container).toBeEmptyDOMElement()
    })
})
```

Create `ui/Feed/Feed.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Feed } from './Feed'

const events = [
    { time: '21:17', text: 'Deploy started on live' },
    { time: '21:14', text: 'web exited 137', bad: true },
]

describe('Feed', () => {
    it('is a list, so how many events there are is announced', () => {
        render(<Feed events={events} />)
        expect(screen.getAllByRole('listitem')).toHaveLength(2)
    })

    it('marks a time as a time', () => {
        const { container } = render(<Feed events={events} />)
        expect(container.querySelector('time')).toHaveTextContent('21:17')
    })

    it('does not rely on red alone to say something went wrong', () => {
        render(<Feed events={events} />)
        // the text itself carries the failure, which is why no icon or label is added here
        expect(screen.getByText('web exited 137')).toBeInTheDocument()
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/KeyValue ui/Feed`
Expected: FAIL, two unresolved imports.

- [ ] **Step 3: Write the stylesheets**

Create `ui/KeyValue/KeyValue.module.css`:

```css
.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 11.5px; margin: 0; }
.key { color: var(--ink-3); font-family: var(--font-mono), monospace; font-size: 11px; }
.value { margin: 0; color: var(--ink-2); }
.value.warn { color: var(--warn); }
.value.crit { color: var(--soft-red); }
```

Create `ui/Feed/Feed.module.css`:

```css
.feed { list-style: none; margin: 0; padding: 0; }

.event {
    display: grid;
    grid-template-columns: 44px 1fr;
    gap: 11px;
    padding: 6px 0;
    font-size: 12.5px;
    border-bottom: 1px solid var(--rule);
}
.event:last-child { border-bottom: 0; }

.time { font-family: var(--font-mono), monospace; color: var(--ink-3); font-size: 11.5px; }
.text { color: var(--ink-2); }
.bad .text { color: var(--soft-red); }
```

- [ ] **Step 4: Write the components**

Create `ui/KeyValue/KeyValue.tsx`:

```tsx
import type { ReactNode } from 'react'

import styles from './KeyValue.module.css'

type Pair = {
    key: string
    value: ReactNode
    tone?: 'warn' | 'crit'
}

export function KeyValue({ pairs }: { pairs: Pair[] }) {
    if (!pairs.length) return null
    return (
        <dl className={styles.kv}>
            {pairs.map(pair => (
                <div style={{ display: 'contents' }} key={pair.key}>
                    <dt className={styles.key}>{pair.key}</dt>
                    <dd className={[styles.value, pair.tone && styles[pair.tone]].filter(Boolean).join(' ')}>
                        {pair.value}
                    </dd>
                </div>
            ))}
        </dl>
    )
}
```

Create `ui/Feed/Feed.tsx`:

```tsx
import type { ReactNode } from 'react'

import styles from './Feed.module.css'

type Event = {
    time: string
    text: ReactNode
    bad?: boolean
}

export function Feed({ events }: { events: Event[] }) {
    return (
        <ul className={styles.feed}>
            {events.map((event, index) => (
                <li className={[styles.event, event.bad && styles.bad].filter(Boolean).join(' ')} key={index}>
                    <time className={styles.time}>{event.time}</time>
                    <span className={styles.text}>{event.text}</span>
                </li>
            ))}
        </ul>
    )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run ui/KeyValue ui/Feed`
Expected: PASS, five tests.

- [ ] **Step 6: Commit**

```bash
git add ui/KeyValue ui/Feed
git commit -m "Add the KeyValue and Feed components"
```

---

### Task 5: LogPane

**Files:**
- Create: `ui/LogPane/LogPane.tsx`, `ui/LogPane/LogPane.module.css`
- Test: `ui/LogPane/LogPane.test.tsx`

**Interfaces:**
- Produces: `LogPane`, props `{ lines: { time: string, text: string, stream?: 'out' | 'err' }[], label: string, following?: boolean }`

- [ ] **Step 1: Write the failing test**

Create `ui/LogPane/LogPane.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LogPane } from './LogPane'

const lines = [
    { time: '21:13:58', text: 'Ready on http://0.0.0.0:3000' },
    { time: '21:14:11', text: 'exited with code 137', stream: 'err' as const },
]

describe('LogPane', () => {
    it('is reachable and scrollable by keyboard, with a name saying what it holds', () => {
        // A scrollable region that cannot be focused is unreachable without a mouse. This is the
        // obligation most easily missed, and the reason this component exists at all.
        render(<LogPane lines={lines} label="asot-web log" />)
        const pane = screen.getByRole('region', { name: 'asot-web log' })
        expect(pane).toHaveAttribute('tabindex', '0')
    })

    it('shows every line with its time', () => {
        render(<LogPane lines={lines} label="asot-web log" />)
        expect(screen.getByText('Ready on http://0.0.0.0:3000')).toBeInTheDocument()
        expect(screen.getByText('21:14:11')).toBeInTheDocument()
    })

    it('does not announce every arriving line', () => {
        // A following log is a firehose. Making it a live region would read the whole thing aloud.
        const { container } = render(<LogPane lines={lines} label="asot-web log" following />)
        expect(container.querySelector('[aria-live]')).not.toBeInTheDocument()
    })

    it('says so when there is nothing yet, rather than showing an empty box', () => {
        render(<LogPane lines={[]} label="asot-web log" />)
        expect(screen.getByText(/nothing yet/i)).toBeInTheDocument()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/LogPane/LogPane.test.tsx`
Expected: FAIL, cannot resolve `./LogPane`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/LogPane/LogPane.module.css`:

```css
.pane {
    background: var(--night);
    border: 1px solid var(--rule);
    border-radius: 6px;
    height: 290px;
    overflow: auto;
    padding: 10px 12px;
    font-family: var(--font-mono), monospace;
    font-size: 11.5px;
    line-height: 1.75;
}
.pane:focus-visible { outline: 2px solid var(--lake); outline-offset: 2px; }

.line { display: flex; gap: 13px; }
.time { color: var(--ink-3); flex: none; }
.text { color: var(--ink-2); white-space: pre-wrap; word-break: break-word; }
.err .text { color: var(--soft-red); }

.empty { color: var(--ink-3); }
```

- [ ] **Step 4: Write the component**

Create `ui/LogPane/LogPane.tsx`:

```tsx
'use client'

import { useEffect, useRef } from 'react'

import styles from './LogPane.module.css'

type Line = {
    time: string
    text: string
    stream?: 'out' | 'err'
}

type Props = {
    lines: Line[]
    label: string
    following?: boolean
}

export function LogPane({ lines, label, following }: Props) {
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        // Newest at the bottom, like every log anyone has ever read
        const pane = ref.current
        if (pane && following) pane.scrollTop = pane.scrollHeight
    }, [lines, following])

    return (
        <div
            ref={ref}
            className={styles.pane}
            role="region"
            aria-label={label}
            // A region that scrolls must be focusable, or a keyboard cannot scroll it
            tabIndex={0}
        >
            {lines.length === 0
                ? <div className={styles.empty}>Nothing yet.</div>
                : lines.map((line, index) => (
                    <div className={[styles.line, line.stream === 'err' && styles.err].filter(Boolean).join(' ')} key={index}>
                        <span className={styles.time}>{line.time}</span>
                        <span className={styles.text}>{line.text}</span>
                    </div>
                ))}
        </div>
    )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/LogPane/LogPane.test.tsx`
Expected: PASS, four tests.

- [ ] **Step 6: Commit**

```bash
git add ui/LogPane
git commit -m "Add the LogPane component"
```

---

### Task 6: DataTable

Deploy history, backups and domains are all tables. Real ones.

**Files:**
- Create: `ui/DataTable/DataTable.tsx`, `ui/DataTable/DataTable.module.css`
- Test: `ui/DataTable/DataTable.test.tsx`

**Interfaces:**
- Produces: `DataTable`, props `{ label: string, columns: { key: string, head: string, numeric?: boolean }[], rows: Record<string, ReactNode>[] }`

- [ ] **Step 1: Write the failing test**

Create `ui/DataTable/DataTable.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DataTable } from './DataTable'

const columns = [
    { key: 'commit', head: 'commit' },
    { key: 'when', head: 'when', numeric: true },
]
const rows = [
    { commit: 'a3f19c2', when: 'Fri 16:40' },
    { commit: 'd40e7b8', when: 'Thu 11:02' },
]

describe('DataTable', () => {
    it('is a real table with a name', () => {
        render(<DataTable label="Deploy history" columns={columns} rows={rows} />)
        expect(screen.getByRole('table', { name: 'Deploy history' })).toBeInTheDocument()
    })

    it('gives every header cell a scope, so a screen reader can pair a cell with its column', () => {
        render(<DataTable label="Deploy history" columns={columns} rows={rows} />)
        screen.getAllByRole('columnheader').forEach(cell => {
            expect(cell).toHaveAttribute('scope', 'col')
        })
    })

    it('renders a cell for every column of every row', () => {
        render(<DataTable label="Deploy history" columns={columns} rows={rows} />)
        expect(screen.getAllByRole('row')).toHaveLength(3)
        expect(screen.getByText('a3f19c2')).toBeInTheDocument()
        expect(screen.getByText('Thu 11:02')).toBeInTheDocument()
    })

    it('says so when it is empty, instead of showing headers over nothing', () => {
        render(<DataTable label="Deploy history" columns={columns} rows={[]} empty="No deploys yet." />)
        expect(screen.getByText('No deploys yet.')).toBeInTheDocument()
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/DataTable/DataTable.test.tsx`
Expected: FAIL, cannot resolve `./DataTable`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/DataTable/DataTable.module.css`:

```css
/* The page must never scroll sideways, so a wide table scrolls inside its own box */
.wrap { overflow-x: auto; }

.table { width: 100%; border-collapse: collapse; font-size: 12.5px; }

.table th {
    text-align: left;
    font-weight: 400;
    color: var(--ink-3);
    font-size: 10.5px;
    font-family: var(--font-mono), monospace;
    padding: 0 14px 7px 0;
    border-bottom: 1px solid var(--rule);
    white-space: nowrap;
}

.table td {
    padding: 9px 14px 9px 0;
    border-bottom: 1px solid var(--rule);
    vertical-align: top;
}

.table th:last-child, .table td:last-child { padding-right: 0; text-align: right; }

.numeric {
    font-family: var(--font-mono), monospace;
    font-variant-numeric: tabular-nums;
    color: var(--ink-3);
    white-space: nowrap;
}

.empty { color: var(--ink-3); font-size: 12.5px; padding: 12px 0; }
```

- [ ] **Step 4: Write the component**

Create `ui/DataTable/DataTable.tsx`:

```tsx
import type { ReactNode } from 'react'

import styles from './DataTable.module.css'

type Column = {
    key: string
    head: string
    numeric?: boolean
}

type Props = {
    label: string
    columns: Column[]
    rows: Record<string, ReactNode>[]
    empty?: string
}

export function DataTable({ label, columns, rows, empty = 'Nothing here yet.' }: Props) {
    // Column headings over no rows say a table failed to load, which is not what an empty list means
    if (!rows.length) return <p className={styles.empty}>{empty}</p>

    return (
        <div className={styles.wrap}>
            <table className={styles.table} aria-label={label}>
                <thead>
                    <tr>
                        {columns.map(column => (
                            <th key={column.key} scope="col" className={column.numeric ? styles.numeric : undefined}>
                                {column.head}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, index) => (
                        <tr key={index}>
                            {columns.map(column => (
                                <td key={column.key} className={column.numeric ? styles.numeric : undefined}>
                                    {row[column.key]}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/DataTable/DataTable.test.tsx`
Expected: PASS, four tests.

- [ ] **Step 6: Commit**

```bash
git add ui/DataTable
git commit -m "Add the DataTable component"
```

---

### Task 7: Shell

The three zones, the top bar and the drawer. The biggest of these and the one carrying the rule that matters most.

**Files:**
- Create: `ui/Shell/Shell.tsx`, `ui/Shell/Shell.module.css`
- Test: `ui/Shell/Shell.test.tsx`

**Interfaces:**
- Produces: `Shell`, props `{ brand: ReactNode, bar?: ReactNode, nav: ReactNode, rail?: ReactNode, children: ReactNode }`

- [ ] **Step 1: Write the failing test**

Create `ui/Shell/Shell.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Shell } from './Shell'

function setup() {
    return render(
        <Shell
            brand="Horizons"
            nav={<button type="button">ASOT</button>}
            rail={<p>the machine</p>}
        >
            <h1>Dashboard</h1>
        </Shell>,
    )
}

describe('Shell', () => {
    it('gives each zone its own landmark', () => {
        setup()
        expect(screen.getByRole('navigation')).toBeInTheDocument()
        expect(screen.getByRole('main')).toBeInTheDocument()
        expect(screen.getByRole('complementary')).toBeInTheDocument()
    })

    it('keeps the rail in the document, since hiding it would lose what it holds', () => {
        // The width at which it moves is a CSS decision no test can see. What a test can hold is that
        // the content is always rendered, so it can never be lost by a breakpoint.
        setup()
        expect(screen.getByText('the machine')).toBeInTheDocument()
    })

    it('opens the drawer from the menu button and says so', async () => {
        setup()
        const menu = screen.getByRole('button', { name: /site list/i })
        expect(menu).toHaveAttribute('aria-expanded', 'false')
        await userEvent.click(menu)
        expect(menu).toHaveAttribute('aria-expanded', 'true')
    })

    it('closes on Escape and puts focus back on the button that opened it', async () => {
        setup()
        const menu = screen.getByRole('button', { name: /site list/i })
        await userEvent.click(menu)
        await userEvent.keyboard('{Escape}')
        expect(menu).toHaveAttribute('aria-expanded', 'false')
        expect(menu).toHaveFocus()
    })

    it('closes when something inside the drawer is chosen', async () => {
        setup()
        const menu = screen.getByRole('button', { name: /site list/i })
        await userEvent.click(menu)
        await userEvent.click(screen.getByRole('button', { name: 'ASOT' }))
        expect(menu).toHaveAttribute('aria-expanded', 'false')
    })

    it('omits the rail cleanly when a page has no context to show', () => {
        render(<Shell brand="Horizons" nav={<span />}><p>body</p></Shell>)
        expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/Shell/Shell.test.tsx`
Expected: FAIL, cannot resolve `./Shell`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/Shell/Shell.module.css`. **The rail is never `display: none`.** At every width it is either the third column or a band under the content.

```css
.bar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--rule);
    position: sticky;
    top: env(safe-area-inset-top, 0px);
    background: var(--night);
    z-index: 20;
}
.brand { font-weight: 600; font-size: 14.5px; letter-spacing: -.01em; }
.barExtra { margin-left: auto; display: flex; align-items: center; gap: 12px; }

.menu { display: none; }

.shell { display: grid; grid-template-columns: 212px minmax(0, 1fr) 272px; }
.nav { border-right: 1px solid var(--rule); padding: 14px 10px 18px; }
.main { padding: 20px 22px 34px; min-width: 0; }
.rail { border-left: 1px solid var(--rule); padding: 20px 18px 34px; }

.scrim { display: none; }

/* Two zones, the rail beneath the content rather than gone */
@media (max-width: 1080px) {
    .shell { grid-template-columns: 208px minmax(0, 1fr); }
    .nav { grid-row: 1 / 3; }
    .main { grid-column: 2; grid-row: 1; }
    .rail { grid-column: 2; grid-row: 2; border-left: 0; border-top: 1px solid var(--rule); }
}

/* One column, and the site list becomes a drawer */
@media (max-width: 760px) {
    .menu {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: 1px solid var(--rule-hi);
        border-radius: 6px;
        color: var(--ink-2);
        flex: none;
        background: none;
        cursor: pointer;
    }
    .menu:focus-visible { outline: 2px solid var(--lake); outline-offset: 2px; }

    .shell { grid-template-columns: 1fr; }
    .main { grid-column: 1; grid-row: 1; padding: 18px 16px 30px; }
    .rail { grid-column: 1; grid-row: 2; padding: 18px 16px 34px; }

    .nav {
        position: fixed;
        top: 0;
        bottom: 0;
        left: 0;
        width: 252px;
        z-index: 60;
        overflow-y: auto;
        background: var(--night);
        border-right: 1px solid var(--rule);
        padding: calc(14px + env(safe-area-inset-top, 0px)) 10px calc(18px + env(safe-area-inset-bottom, 0px));
        transform: translateX(-100%);
        transition: transform .18s ease;
    }
    .open { transform: none; }
    .scrim { display: block; position: fixed; inset: 0; z-index: 55; background: rgba(4, 6, 10, .62); }
}

@media (prefers-reduced-motion: reduce) {
    .nav { transition: none; }
}
```

- [ ] **Step 4: Write the component**

Create `ui/Shell/Shell.tsx`:

```tsx
'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

import styles from './Shell.module.css'

type Props = {
    brand: ReactNode
    bar?: ReactNode
    nav: ReactNode
    rail?: ReactNode
    children: ReactNode
}

export function Shell({ brand, bar, nav, rail, children }: Props) {
    const [open, setOpen] = useState(false)
    const menuRef = useRef<HTMLButtonElement>(null)
    const navRef = useRef<HTMLElement>(null)

    function close() {
        setOpen(false)
        menuRef.current?.focus()
    }

    useEffect(() => {
        if (!open) return
        // Focus the first thing in the drawer, so a keyboard lands inside what it just opened
        const first = navRef.current?.querySelector<HTMLElement>('button, a')
        if (first) first.focus()

        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape') close()
        }
        // A drawer left open while the window grows back would strand the scrim over three zones
        function onResize() {
            if (window.innerWidth > 760) setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onResize)
        return () => {
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('resize', onResize)
        }
    }, [open])

    return (
        <>
            <header className={styles.bar}>
                <button
                    ref={menuRef}
                    type="button"
                    className={styles.menu}
                    aria-label="Open the site list"
                    aria-expanded={open}
                    onClick={() => (open ? close() : setOpen(true))}
                >
                    &#9776;
                </button>
                <span className={styles.brand}>{brand}</span>
                {bar && <span className={styles.barExtra}>{bar}</span>}
            </header>

            <div className={styles.shell}>
                <nav
                    ref={navRef}
                    className={[styles.nav, open && styles.open].filter(Boolean).join(' ')}
                    // Anything chosen in here has served its purpose, so the drawer closes behind it
                    onClick={event => { if ((event.target as HTMLElement).closest('button, a')) close() }}
                >
                    {nav}
                </nav>
                <main className={styles.main}>{children}</main>
                {rail && <aside className={styles.rail}>{rail}</aside>}
            </div>

            {open && <div className={styles.scrim} onClick={close} />}
        </>
    )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/Shell/Shell.test.tsx`
Expected: PASS, six tests.

One thing to watch: the drawer's click handler closes on anything matching `button, a`, which is how a
choice dismisses it. If a control lands in the nav that should *not* close it (a disclosure toggle, say),
that handler needs narrowing rather than the control needing a workaround.

- [ ] **Step 6: Commit**

```bash
git add ui/Shell
git commit -m "Add the Shell component, three zones and a drawer"
```

---

### Task 8: Put them all in the gallery

**Files:**
- Modify: `app/(admin)/admin/ui/gallery.tsx`

- [ ] **Step 1: Add a row for each new component**

Follow the shape the gallery already uses: a `Row` helper per component with a title, a note saying what to
look for, and every state side by side. Add, in this order: `Row` (plain, clickable, crit, warn), `Meter`
(with and without a threshold, and one at 104% to prove the clamp), `StatStrip`, `KeyValue`, `Feed` (with one
bad event), `LogPane` (with lines and empty), `DataTable` (with rows and empty).

**Do not put `Shell` in the gallery.** It is the page frame, and nesting one inside a page that already has
a frame proves nothing. It is judged on the real pages instead.

- [ ] **Step 2: Look at it**

Run `npm run dev` and open `/admin/ui`. Signing in is Google OAuth; if you have no session, say so plainly
in the PR and leave these unticked rather than claiming them.

The palette changed from navy to Readout while this plan ran, so look at contrast first:
- Is the amber `warn` text readable on the new, less blue ground? It is the likeliest casualty.
- Does the `crit` left border on a `Row` read as a severity rail, or as an accident?
- Is the `Meter` tick visible against its fill, and against the track where they meet?
- Is the `LogPane` focus ring visible when you tab into it?
- Does the empty `DataTable` message look deliberate rather than broken?

Fix what looks wrong in the component, not in the gallery.

- [ ] **Step 3: Check everything**

Run: `npx vitest run && npm run build && npm run wallpaper && npm run lint && npx tsc --noEmit`
Expected: all pass.

Then: `grep -rnE "#[0-9a-fA-F]{3,8}" ui/ --include=*.module.css`
Expected: matches only inside `rgba()` alpha values.

- [ ] **Step 4: Commit**

```bash
git add "app/(admin)/admin/ui/gallery.tsx"
git commit -m "Show the portal components in the gallery"
```

---

## Self-review notes

**Against the mockup.** The three-zone mockup uses: the shell, rows, a stat strip, meters, a feed, a log
pane, tables, key-value lists, tabs, chips and buttons. The last three exist already. Everything else is a
task above.

**Deliberately not here.** The env editor's rows, the environment panels on a site's Overview, and the
alert trail are **page composition**, not components: each appears once, on one page, and turning a
one-off arrangement into a component with six props makes it harder to read, not easier. They belong in the
page.

**`Tabs` is reused, not rebuilt.** The site page's six tabs are the existing component, which already
handles roving tabindex and arrow keys.
