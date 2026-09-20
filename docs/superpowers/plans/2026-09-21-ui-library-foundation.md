# UI library foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tokens, the test setup and the components that MUI was providing, so that converting the app away from MUI becomes mechanical.

**Architecture:** A `ui/` directory at the repo root, mirroring `server/`, reached through the existing `@/*` alias. Tokens are CSS custom properties with a TypeScript mirror and a test that the two agree. Components are CSS modules, because `tailwind.config.ts` sets `important: true` and every utility is therefore `!important`. Each component's accessibility obligations are tests, because those failures are silent.

**Tech Stack:** TypeScript, React 18, Next.js 15 App Router, CSS modules, vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-20-ui-library-design.md`

## Global Constraints

- **No em dashes** (U+2014) anywhere: code comments are the only exception, per `CLAUDE.md`.
- **House style:** four-space indent, no semicolons, single quotes, named exports.
- Nothing in `ui/` imports from `server/`, and nothing in `ui/` imports MUI.
- Every colour comes from a token. A hex value written inside a component's stylesheet is a bug.
- The landing scene's own surfaces stay as their own named pair: `#101727` and `#0b0d1c`, tuned to the artwork, not unified with the portal's.
- `tailwind.config.ts` keeps `important: true`. Nothing in this plan changes it or the perf rules in `app/globals.css` that depend on it.
- Tests run with `npx vitest run`.

## Scope

This plan builds the foundation only: the test setup, the tokens, the fonts, and the components. **Converting the 29 files that use MUI, and removing the six packages, is a separate plan**, written once these components exist and their real signatures are known. Nothing in this plan changes an existing page, so it can land while other work is in flight.

---

### Task 1: Somewhere to test components

**Files:**
- Modify: `package.json` (four dev dependencies)
- Modify: `vitest.config.ts` (a third project)
- Create: `ui/testing/setup.ts`
- Test: `ui/testing/setup.test.tsx`

**Interfaces:**
- Produces: a vitest project named `ui` that runs `ui/**/*.test.tsx` in jsdom, which every later task depends on.

- [ ] **Step 1: Add the dependencies**

```bash
npm install --save-dev @testing-library/react@16.1.0 @testing-library/user-event@14.5.2 @testing-library/jest-dom@6.6.3 jsdom@25.0.1
```

- [ ] **Step 2: Write the failing test**

Create `ui/testing/setup.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('the ui test project', () => {
    it('renders a component and can assert on the document', () => {
        render(<button type="button">Press me</button>)
        expect(screen.getByRole('button', { name: 'Press me' })).toBeInTheDocument()
    })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run ui/testing/setup.test.tsx`
Expected: FAIL. The file is not matched by any project, or `document is not defined`, because the existing
projects only include `*.test.ts` and run in the `node` environment.

- [ ] **Step 4: Write the setup file**

Create `ui/testing/setup.ts`:

```ts
// Brings in jest-dom's matchers (toBeInTheDocument, toHaveAccessibleName and the rest) and clears the
// rendered tree between tests, so one test's dialog cannot be found by the next.

import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)
```

- [ ] **Step 5: Add the project**

In `vitest.config.ts`, add a third entry to `test.projects`, after the `db` one:

```ts
            {
                extends: true,
                test: {
                    name: 'ui',
                    // Components need a DOM, which the other two projects deliberately do without.
                    environment: 'jsdom',
                    include: ['ui/**/*.test.tsx'],
                    setupFiles: ['./ui/testing/setup.ts'],
                },
            },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run ui/testing/setup.test.tsx`
Expected: PASS, one test.

- [ ] **Step 7: Check the other projects still run**

Run: `npx vitest run`
Expected: all three projects pass. The `unit` and `db` projects are unchanged.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts ui/testing/setup.ts ui/testing/setup.test.tsx
git commit -m "Add a vitest project for component tests"
```

---

### Task 2: The tokens

**Files:**
- Create: `ui/tokens.css`
- Create: `ui/tokens.ts`
- Test: `ui/tokens.test.ts`
- Modify: `app/globals.css` (import the tokens)
- Modify: `vitest.config.ts` (the `unit` project must include `ui/*.test.ts`)

**Interfaces:**
- Produces: the custom properties every later stylesheet reads, and `TOKENS`, a record of the same names and values for the few places a value is needed in script.

- [ ] **Step 1: Write the failing test**

Create `ui/tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TOKENS } from './tokens'

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

function propertiesIn(source: string): Record<string, string> {
    const found: Record<string, string> = {}
    for (const line of source.split('\n')) {
        const match = line.match(/^\s*--([a-z0-9-]+):\s*(.+?);/)
        if (match) found[match[1]] = match[2].trim()
    }
    return found
}

describe('the tokens', () => {
    it('are the same list in the stylesheet and in TypeScript', () => {
        // Two readers, one list. A colour added to one and missed in the other is the bug this catches.
        expect(propertiesIn(css)).toEqual(TOKENS)
    })

    it('keep the surfaces belonging to the scene, which are tuned to the artwork', () => {
        expect(TOKENS['scene-bg']).toBe('#101727')
        expect(TOKENS['scene-paper']).toBe('#0b0d1c')
        expect(TOKENS['night']).toBe('#0b101f')
    })

    it('has no colour written twice under different names', () => {
        const colours = Object.entries(TOKENS).filter(([, value]) => value.startsWith('#'))
        const seen = new Map<string, string>()
        for (const [name, value] of colours) {
            const already = seen.get(value)
            expect(already, `${name} repeats ${already}`).toBeUndefined()
            seen.set(value, name)
        }
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/tokens.test.ts`
Expected: FAIL. The file is not matched by any project yet.

- [ ] **Step 3: Let the unit project see it**

In `vitest.config.ts`, change the `unit` project's `include` to:

```ts
                    include: ['app/**/*.test.ts', 'server/**/*.test.ts', 'ui/**/*.test.ts'],
```

Run it again: `npx vitest run ui/tokens.test.ts`. It should now fail because `./tokens` does not exist.

- [ ] **Step 4: Write the stylesheet**

Create `ui/tokens.css`:

```css
/* The one list of design values. Every component stylesheet reads these and writes no hex of its own.
   ui/tokens.ts mirrors this file, and ui/tokens.test.ts fails if the two drift apart. */

:root {
    --night: #0b101f;
    --deep: #0d1429;
    --panel: #111a38;
    --panel-hi: #16224a;
    --rule: #1f2b52;
    --rule-hi: #2c3c6e;

    /* The landing scene and the wallpaper, tuned to the artwork rather than the portal */
    --scene-bg: #101727;
    --scene-paper: #0b0d1c;

    --ink: #eef2ff;
    --ink-2: #a9b6dd;
    --ink-3: #6f7da8;

    /* lake is the one interactive accent; blush means a person did this, and nothing else */
    --lake: #8fd4f5;
    --lake-hi: #a8ddf7;
    --blush: #f19bb3;

    --good: #6fd39b;
    --warn: #f0b45c;
    --crit: #f4685f;
    --soft-red: #ffb3ad;

    --radius-chip: 4px;
    --radius-control: 7px;
    --radius-panel: 9px;
    --radius-card: 11px;
}
```

- [ ] **Step 5: Write the mirror**

Create `ui/tokens.ts`:

```ts
// The same list as ui/tokens.css, for the few places a value is needed in script rather than in a
// stylesheet, such as a meter's fill. ui/tokens.test.ts fails if the two drift apart.

export const TOKENS: Record<string, string> = {
    'night': '#0b101f',
    'deep': '#0d1429',
    'panel': '#111a38',
    'panel-hi': '#16224a',
    'rule': '#1f2b52',
    'rule-hi': '#2c3c6e',

    'scene-bg': '#101727',
    'scene-paper': '#0b0d1c',

    'ink': '#eef2ff',
    'ink-2': '#a9b6dd',
    'ink-3': '#6f7da8',

    'lake': '#8fd4f5',
    'lake-hi': '#a8ddf7',
    'blush': '#f19bb3',

    'good': '#6fd39b',
    'warn': '#f0b45c',
    'crit': '#f4685f',
    'soft-red': '#ffb3ad',

    'radius-chip': '4px',
    'radius-control': '7px',
    'radius-panel': '9px',
    'radius-card': '11px',
}

// Two densities, one visual language: the operator's screens are dense, the client's are roomy.
// Applied with data-density on the area's layout element.
export const DENSITY = ['operator', 'client'] as const
export type Density = typeof DENSITY[number]
```

- [ ] **Step 6: Import the tokens**

At the top of `app/globals.css`, after the three `@tailwind` lines, add:

```css
@import '../ui/tokens.css';
```

Then delete the `--background` and `--foreground` declarations from the existing `:root` block only if
nothing still reads them. `tailwind.config.ts` maps `background` and `foreground` to them, so **leave them
in place** for now; the conversion plan removes them.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run ui/tokens.test.ts`
Expected: PASS, three tests.

- [ ] **Step 8: Check the site still builds and looks unchanged**

Run: `npm run build && npm run wallpaper`
Expected: both succeed. The tokens are additive, so nothing should render differently yet.

- [ ] **Step 9: Commit**

```bash
git add ui/tokens.css ui/tokens.ts ui/tokens.test.ts app/globals.css vitest.config.ts
git commit -m "Add the design tokens, with a test that CSS and TypeScript agree"
```

---

### Task 3: The second typeface

**Files:**
- Modify: `app/layout.tsx:2,9,64`

**Interfaces:**
- Produces: `--font-sans` and `--font-mono` on the body, which every component stylesheet reads.

- [ ] **Step 1: Load both faces as variables**

In `app/layout.tsx`, change the import on line 2 and the font declaration on line 9:

```tsx
import { IBM_Plex_Mono, Montserrat } from "next/font/google"

const montserrat = Montserrat({ subsets: ["latin"], variable: "--font-sans" })
// Machine text only: commit ids, container names, branches, log lines and file paths
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" })
```

- [ ] **Step 2: Put both on the body**

Change line 64 so both variables are defined and Montserrat still applies as the default face:

```tsx
			<body className={`${montserrat.variable} ${plexMono.variable} ${montserrat.className} antialiased h-full`}>
```

- [ ] **Step 3: Check the build and the wallpaper export**

Run: `npm run build && npm run wallpaper`
Expected: both succeed. `next/font` self-hosts both faces, so no network request is added.

- [ ] **Step 4: Check the page still renders in Montserrat**

Run: `npm run dev`, open the landing page, and confirm in devtools that `body` computes to the Montserrat
family and that `--font-mono` is defined on it. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/layout.tsx
git commit -m "Load IBM Plex Mono beside Montserrat, both as CSS variables"
```

---

### Task 4: Button

**Files:**
- Create: `ui/Button/Button.tsx`
- Create: `ui/Button/Button.module.css`
- Test: `ui/Button/Button.test.tsx`

**Interfaces:**
- Produces: `Button`, props `{ variant?: 'primary' | 'quiet', size?: 'small' | 'medium' }` plus everything `<button>` accepts.

- [ ] **Step 1: Write the failing test**

Create `ui/Button/Button.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Button } from './Button'

describe('Button', () => {
    it('is a real button, so the keyboard works without any help from us', async () => {
        const onClick = vi.fn()
        render(<Button onClick={onClick}>Restart</Button>)
        const button = screen.getByRole('button', { name: 'Restart' })
        button.focus()
        await userEvent.keyboard('{Enter}')
        expect(onClick).toHaveBeenCalledOnce()
    })

    it('defaults to type button, so it never submits a form by accident', () => {
        render(<Button>Restart</Button>)
        expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
    })

    it('can still be a submit button when asked', () => {
        render(<Button type="submit">Save</Button>)
        expect(screen.getByRole('button')).toHaveAttribute('type', 'submit')
    })

    it('does not fire when disabled', async () => {
        const onClick = vi.fn()
        render(<Button disabled onClick={onClick}>Stop</Button>)
        await userEvent.click(screen.getByRole('button'))
        expect(onClick).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/Button/Button.test.tsx`
Expected: FAIL, cannot resolve `./Button`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/Button/Button.module.css`:

```css
.button {
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.5;
    padding: 6px 12px;
    border: 1px solid var(--rule-hi);
    border-radius: var(--radius-control);
    background: none;
    color: var(--ink-2);
    white-space: nowrap;
    cursor: pointer;
    transition: background .12s, color .12s, border-color .12s;
}

.button:hover:not(:disabled) {
    background: var(--panel-hi);
    color: var(--ink);
}

.button:focus-visible {
    outline: 2px solid var(--lake);
    outline-offset: 2px;
}

.button:disabled {
    opacity: .4;
    cursor: not-allowed;
}

.primary {
    background: var(--lake);
    border-color: var(--lake);
    color: var(--night);
    font-weight: 600;
}

.primary:hover:not(:disabled) {
    background: var(--lake-hi);
    border-color: var(--lake-hi);
    color: var(--night);
}

.quiet {
    border-color: transparent;
    color: var(--ink-3);
}

.small {
    font-size: 11.5px;
    padding: 3px 9px;
    border-radius: var(--radius-chip);
}
```

- [ ] **Step 4: Write the component**

Create `ui/Button/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react'

import styles from './Button.module.css'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'quiet'
    size?: 'small' | 'medium'
}

export function Button({ variant, size, className, type, ...rest }: Props) {
    const classes = [styles.button, variant && styles[variant], size === 'small' && styles.small, className]
        .filter(Boolean)
        .join(' ')
    // A button with no type submits the form it sits in, which has surprised everyone at least once.
    return <button type={type ?? 'button'} className={classes} {...rest} />
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/Button/Button.test.tsx`
Expected: PASS, four tests.

- [ ] **Step 6: Commit**

```bash
git add ui/Button
git commit -m "Add the Button component"
```

---

### Task 5: Field

This is the one that matters. 22 of the MUI uses being replaced are `TextField`, and the wiring it does
silently is what a hand-rolled input usually gets wrong.

**Files:**
- Create: `ui/Field/Field.tsx`
- Create: `ui/Field/Field.module.css`
- Test: `ui/Field/Field.test.tsx`

**Interfaces:**
- Produces: `Field`, props `{ label: string, hint?: string, error?: string, as?: 'input' | 'textarea' }` plus everything `<input>` accepts.

- [ ] **Step 1: Write the failing test**

Create `ui/Field/Field.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Field } from './Field'

describe('Field', () => {
    it('ties the label to the input, so clicking the label focuses it', async () => {
        render(<Field label="Email" name="email" />)
        await userEvent.click(screen.getByText('Email'))
        expect(screen.getByLabelText('Email')).toHaveFocus()
    })

    it('reads the hint out as part of the field', () => {
        render(<Field label="Email" name="email" hint="We only use this to reply" />)
        expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('We only use this to reply')
    })

    it('marks an errored field invalid and describes it by the error', () => {
        render(<Field label="Email" name="email" error="Enter a valid email address" />)
        const input = screen.getByLabelText('Email')
        expect(input).toHaveAttribute('aria-invalid', 'true')
        expect(input).toHaveAccessibleDescription('Enter a valid email address')
    })

    it('keeps both the hint and the error when there are both', () => {
        render(<Field label="Email" name="email" hint="We only use this to reply" error="Enter a valid email address" />)
        expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('We only use this to reply Enter a valid email address')
    })

    it('is not invalid when there is no error', () => {
        render(<Field label="Email" name="email" />)
        expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'false')
    })

    it('gives two fields with the same label different ids', () => {
        render(<><Field label="Email" name="a" /><Field label="Email" name="b" /></>)
        const [first, second] = screen.getAllByLabelText('Email')
        expect(first.id).not.toBe(second.id)
    })

    it('can be a textarea', () => {
        render(<Field as="textarea" label="Message" name="message" />)
        expect(screen.getByLabelText('Message').tagName).toBe('TEXTAREA')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/Field/Field.test.tsx`
Expected: FAIL, cannot resolve `./Field`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/Field/Field.module.css`:

```css
.field {
    display: grid;
    gap: 6px;
}

.label {
    font-size: 12.5px;
    color: var(--ink-2);
}

.control {
    font: inherit;
    font-size: 13.5px;
    color: var(--ink);
    background: var(--night);
    border: 1px solid var(--rule-hi);
    border-radius: var(--radius-control);
    padding: 9px 11px;
    width: 100%;
}

.control:focus-visible {
    outline: 2px solid var(--lake);
    outline-offset: 1px;
}

.invalid {
    border-color: var(--crit);
}

.hint {
    font-size: 12px;
    color: var(--ink-3);
}

/* The mark carries the error as well as the colour, for anyone who cannot see the red */
.error {
    font-size: 12px;
    color: var(--soft-red);
}

.error::before {
    content: '▲ ';
}
```

- [ ] **Step 4: Write the component**

Create `ui/Field/Field.tsx`:

```tsx
'use client'

import { useId, type InputHTMLAttributes } from 'react'

import styles from './Field.module.css'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
    label: string
    hint?: string
    error?: string
    as?: 'input' | 'textarea'
}

export function Field({ label, hint, error, as = 'input', className, ...rest }: Props) {
    // useId rather than the name, so two fields with the same label on one page still get different ids
    const id = useId()
    const hintId = `${id}-hint`
    const errorId = `${id}-error`

    // Order matters: a screen reader reads the description in the order given, and the hint explains the
    // field while the error explains what went wrong with it.
    const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined

    const controlProps = {
        id,
        className: [styles.control, error && styles.invalid, className].filter(Boolean).join(' '),
        'aria-invalid': error ? true : false,
        'aria-describedby': describedBy,
        ...rest,
    }

    return (
        <div className={styles.field}>
            <label className={styles.label} htmlFor={id}>{label}</label>
            {as === 'textarea'
                ? <textarea {...(controlProps as object)} />
                : <input {...controlProps} />}
            {hint && <span className={styles.hint} id={hintId}>{hint}</span>}
            {error && <span className={styles.error} id={errorId}>{error}</span>}
        </div>
    )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/Field/Field.test.tsx`
Expected: PASS, seven tests.

- [ ] **Step 6: Commit**

```bash
git add ui/Field
git commit -m "Add the Field component, with its label and error wiring tested"
```

---

### Task 6: Dialog

**Files:**
- Create: `ui/Dialog/Dialog.tsx`
- Create: `ui/Dialog/Dialog.module.css`
- Test: `ui/Dialog/Dialog.test.tsx`

**Interfaces:**
- Produces: `Dialog`, props `{ open: boolean, onClose: () => void, title: string, children, footer? }`.

- [ ] **Step 1: Write the failing test**

Create `ui/Dialog/Dialog.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Dialog } from './Dialog'

describe('Dialog', () => {
    it('is named by its heading', () => {
        render(<Dialog open title="Roll back live to d40e7b8?" onClose={() => {}}>Body</Dialog>)
        expect(screen.getByRole('dialog')).toHaveAccessibleName('Roll back live to d40e7b8?')
    })

    it('is not in the document when closed', () => {
        render(<Dialog open={false} title="Roll back" onClose={() => {}}>Body</Dialog>)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('closes on Escape', async () => {
        const onClose = vi.fn()
        render(<Dialog open title="Roll back" onClose={onClose}>Body</Dialog>)
        await userEvent.keyboard('{Escape}')
        expect(onClose).toHaveBeenCalled()
    })

    it('closes from its own close button', async () => {
        const onClose = vi.fn()
        render(<Dialog open title="Roll back" onClose={onClose}>Body</Dialog>)
        await userEvent.click(screen.getByRole('button', { name: /close/i }))
        expect(onClose).toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/Dialog/Dialog.test.tsx`
Expected: FAIL, cannot resolve `./Dialog`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/Dialog/Dialog.module.css`:

```css
.dialog {
    width: min(660px, calc(100vw - 32px));
    padding: 0;
    border: 1px solid var(--rule-hi);
    border-radius: var(--radius-card);
    background: var(--panel);
    color: var(--ink);
}

.dialog::backdrop {
    background: rgba(4, 7, 16, .8);
}

.head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--rule);
}

.title {
    margin: 0;
    font-size: 14.5px;
    font-weight: 600;
}

.close {
    margin-left: auto;
}

.body { padding: 16px; }

.footer {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding: 13px 16px;
    border-top: 1px solid var(--rule);
}
```

- [ ] **Step 4: Write the component**

Create `ui/Dialog/Dialog.tsx`:

```tsx
'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'

import { Button } from '../Button/Button'
import styles from './Dialog.module.css'

type Props = {
    open: boolean
    onClose: () => void
    title: string
    children: ReactNode
    footer?: ReactNode
}

export function Dialog({ open, onClose, title, children, footer }: Props) {
    const ref = useRef<HTMLDialogElement>(null)
    const titleId = useId()

    useEffect(() => {
        const dialog = ref.current
        if (!dialog) return
        // showModal is what gives focus trapping, the top layer and inertness of the rest of the page.
        // Opening with the open attribute instead gets none of those.
        if (open && !dialog.open) dialog.showModal()
        if (!open && dialog.open) dialog.close()
    }, [open])

    if (!open) return null

    return (
        <dialog
            ref={ref}
            className={styles.dialog}
            aria-labelledby={titleId}
            // The platform fires cancel for Escape and close when the dialog closes by any route
            onCancel={event => { event.preventDefault(); onClose() }}
            onClose={onClose}
        >
            <div className={styles.head}>
                <h2 className={styles.title} id={titleId}>{title}</h2>
                <Button variant="quiet" size="small" className={styles.close} aria-label="Close" onClick={onClose}>&times;</Button>
            </div>
            <div className={styles.body}>{children}</div>
            {footer && <div className={styles.footer}>{footer}</div>}
        </dialog>
    )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/Dialog/Dialog.test.tsx`
Expected: PASS, four tests.

If Escape does not reach `onCancel`, jsdom's `dialog` support is the cause: check that `jsdom@25` is
installed, since older versions do not implement `showModal`.

- [ ] **Step 6: Commit**

```bash
git add ui/Dialog
git commit -m "Add the Dialog component on the native dialog element"
```

---

### Task 7: Tabs

**Files:**
- Create: `ui/Tabs/Tabs.tsx`
- Create: `ui/Tabs/Tabs.module.css`
- Test: `ui/Tabs/Tabs.test.tsx`

**Interfaces:**
- Produces: `Tabs`, props `{ tabs: { id: string, label: string }[], selected: string, onSelect: (id: string) => void, label: string }`.

- [ ] **Step 1: Write the failing test**

Create `ui/Tabs/Tabs.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Tabs } from './Tabs'

const tabs = [
    { id: 'deploys', label: 'Deploys' },
    { id: 'logs', label: 'Logs' },
    { id: 'env', label: 'Environment' },
]

describe('Tabs', () => {
    it('marks the selected tab and only that one', () => {
        render(<Tabs tabs={tabs} selected="logs" onSelect={() => {}} label="Site tools" />)
        expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tab', { name: 'Deploys' })).toHaveAttribute('aria-selected', 'false')
    })

    it('puts only the selected tab in the tab order, so Tab moves past the set', () => {
        render(<Tabs tabs={tabs} selected="logs" onSelect={() => {}} label="Site tools" />)
        expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('tabindex', '0')
        expect(screen.getByRole('tab', { name: 'Deploys' })).toHaveAttribute('tabindex', '-1')
    })

    it('moves with the arrow keys', async () => {
        const onSelect = vi.fn()
        render(<Tabs tabs={tabs} selected="logs" onSelect={onSelect} label="Site tools" />)
        screen.getByRole('tab', { name: 'Logs' }).focus()
        await userEvent.keyboard('{ArrowRight}')
        expect(onSelect).toHaveBeenCalledWith('env')
    })

    it('wraps around at both ends', async () => {
        const onSelect = vi.fn()
        render(<Tabs tabs={tabs} selected="deploys" onSelect={onSelect} label="Site tools" />)
        screen.getByRole('tab', { name: 'Deploys' }).focus()
        await userEvent.keyboard('{ArrowLeft}')
        expect(onSelect).toHaveBeenCalledWith('env')
    })

    it('has an accessible name for the set', () => {
        render(<Tabs tabs={tabs} selected="logs" onSelect={() => {}} label="Site tools" />)
        expect(screen.getByRole('tablist')).toHaveAccessibleName('Site tools')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/Tabs/Tabs.test.tsx`
Expected: FAIL, cannot resolve `./Tabs`.

- [ ] **Step 3: Write the stylesheet**

Create `ui/Tabs/Tabs.module.css`:

```css
.tablist {
    display: flex;
    gap: 2px;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--rule);
}

.tab {
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    color: var(--ink-3);
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    padding: 9px 13px 10px;
    cursor: pointer;
}

.tab:hover { color: var(--ink-2); }

.tab:focus-visible {
    outline: 2px solid var(--lake);
    outline-offset: -2px;
}

.selected {
    color: var(--ink);
    border-bottom-color: var(--lake);
    font-weight: 600;
}
```

- [ ] **Step 4: Write the component**

Create `ui/Tabs/Tabs.tsx`:

```tsx
'use client'

import type { KeyboardEvent } from 'react'

import styles from './Tabs.module.css'

type Tab = { id: string, label: string }

type Props = {
    tabs: Tab[]
    selected: string
    onSelect: (id: string) => void
    label: string
}

export function Tabs({ tabs, selected, onSelect, label }: Props) {
    // Roving tabindex: the set is one stop in the tab order and the arrows move within it, which is what
    // the tab pattern asks for and what a row of plain buttons gets wrong.
    function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!step) return
        event.preventDefault()
        const index = tabs.findIndex(tab => tab.id === selected)
        const next = tabs[(index + step + tabs.length) % tabs.length]
        onSelect(next.id)
    }

    return (
        <div className={styles.tablist} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
            {tabs.map(tab => (
                <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`tab-${tab.id}`}
                    aria-selected={tab.id === selected}
                    aria-controls={`panel-${tab.id}`}
                    tabIndex={tab.id === selected ? 0 : -1}
                    className={[styles.tab, tab.id === selected && styles.selected].filter(Boolean).join(' ')}
                    onClick={() => onSelect(tab.id)}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/Tabs/Tabs.test.tsx`
Expected: PASS, five tests.

- [ ] **Step 6: Commit**

```bash
git add ui/Tabs
git commit -m "Add the Tabs component with roving tabindex and arrow keys"
```

---

### Task 8: Chip, Callout and StatusDot

**Files:**
- Create: `ui/Chip/Chip.tsx`, `ui/Chip/Chip.module.css`
- Create: `ui/Callout/Callout.tsx`, `ui/Callout/Callout.module.css`
- Create: `ui/StatusDot/StatusDot.tsx`, `ui/StatusDot/StatusDot.module.css`
- Test: `ui/Chip/Chip.test.tsx`, `ui/Callout/Callout.test.tsx`, `ui/StatusDot/StatusDot.test.tsx`

**Interfaces:**
- Produces: `Chip` with `tone?: 'good' | 'warn' | 'crit'`, `Callout` with the same tones and a `title`, `StatusDot` with `state: 'up' | 'down' | 'deploying' | 'stopped' | 'paused'`.

- [ ] **Step 1: Write the failing tests**

Create `ui/StatusDot/StatusDot.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatusDot } from './StatusDot'

describe('StatusDot', () => {
    it('says the state in words, because a colour is not readable to everyone', () => {
        render(<StatusDot state="down" />)
        expect(screen.getByText('down')).toBeInTheDocument()
    })

    it('hides the dot itself from assistive technology, since the word carries the meaning', () => {
        const { container } = render(<StatusDot state="up" />)
        expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
    })
})
```

Create `ui/Callout/Callout.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Callout } from './Callout'

describe('Callout', () => {
    it('announces itself when it carries a problem', () => {
        render(<Callout tone="crit" title="The deploy failed">Live is untouched.</Callout>)
        expect(screen.getByRole('alert')).toHaveTextContent('The deploy failed')
    })

    it('is a plain region when it is only information', () => {
        render(<Callout title="Backups run nightly">At 7pm.</Callout>)
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.getByText('Backups run nightly')).toBeInTheDocument()
    })
})
```

Create `ui/Chip/Chip.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Chip } from './Chip'

describe('Chip', () => {
    it('shows its label as text rather than relying on its colour', () => {
        render(<Chip tone="good">on live now</Chip>)
        expect(screen.getByText('on live now')).toBeInTheDocument()
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/Chip ui/Callout ui/StatusDot`
Expected: FAIL, three unresolved imports.

- [ ] **Step 3: Write the three stylesheets**

Create `ui/Chip/Chip.module.css`:

```css
.chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 500;
    border: 1px solid var(--rule-hi);
    border-radius: 999px;
    padding: 2px 9px;
    color: var(--ink-2);
}

.good { color: var(--good); border-color: rgba(111, 211, 155, .35); }
.warn { color: var(--warn); border-color: rgba(240, 180, 92, .4); }
.crit { color: var(--soft-red); border-color: rgba(244, 104, 95, .45); }
```

Create `ui/Callout/Callout.module.css`:

```css
.callout {
    border: 1px solid var(--rule);
    border-left: 3px solid var(--rule-hi);
    border-radius: var(--radius-panel);
    background: var(--panel);
    padding: 12px 14px;
}

.title { font-weight: 600; font-size: 13px; margin: 0 0 4px; }
.body { color: var(--ink-2); font-size: 12.5px; }

.good { border-left-color: var(--good); }
.warn { border-left-color: var(--warn); }
.crit { border-left-color: var(--crit); }
.crit .title { color: var(--soft-red); }
```

Create `ui/StatusDot/StatusDot.module.css`:

```css
.wrap { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; }

.dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }

.up { background: var(--good); }
.down { background: var(--crit); }
.deploying { background: var(--lake); animation: pulse 1.3s ease-in-out infinite; }
.stopped { background: var(--ink-3); }
.paused { background: var(--warn); }

@keyframes pulse { 50% { opacity: .25; } }

@media (prefers-reduced-motion: reduce) {
    .deploying { animation: none; }
}
```

- [ ] **Step 4: Write the three components**

Create `ui/Chip/Chip.tsx`:

```tsx
import type { ReactNode } from 'react'

import styles from './Chip.module.css'

export function Chip({ tone, children }: { tone?: 'good' | 'warn' | 'crit', children: ReactNode }) {
    return <span className={[styles.chip, tone && styles[tone]].filter(Boolean).join(' ')}>{children}</span>
}
```

Create `ui/Callout/Callout.tsx`:

```tsx
import type { ReactNode } from 'react'

import styles from './Callout.module.css'

type Props = {
    tone?: 'good' | 'warn' | 'crit'
    title: string
    children: ReactNode
}

export function Callout({ tone, title, children }: Props) {
    // A problem should be announced when it appears; a note about how backups work should not interrupt.
    const isProblem = tone === 'crit' || tone === 'warn'
    return (
        <div className={[styles.callout, tone && styles[tone]].filter(Boolean).join(' ')} role={isProblem ? 'alert' : undefined}>
            <p className={styles.title}>{title}</p>
            <div className={styles.body}>{children}</div>
        </div>
    )
}
```

Create `ui/StatusDot/StatusDot.tsx`:

```tsx
import styles from './StatusDot.module.css'

type State = 'up' | 'down' | 'deploying' | 'stopped' | 'paused'

export function StatusDot({ state }: { state: State }) {
    // The word is the meaning; the dot is decoration and is hidden, so nothing depends on colour alone.
    return (
        <span className={styles.wrap}>
            <span className={[styles.dot, styles[state]].join(' ')} aria-hidden="true" />
            <span>{state}</span>
        </span>
    )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run ui/Chip ui/Callout ui/StatusDot`
Expected: PASS, five tests.

- [ ] **Step 6: Commit**

```bash
git add ui/Chip ui/Callout ui/StatusDot
git commit -m "Add Chip, Callout and StatusDot"
```

---

### Task 9: The icons

**Files:**
- Create: `ui/icons/Icon.tsx` (the shared wrapper)
- Create: `ui/icons/index.tsx` (all 26)
- Test: `ui/icons/icons.test.tsx`

**Interfaces:**
- Produces: 26 named icon components, each taking `{ size?: number, title?: string }`.

The 26 that `@mui/icons-material` currently supplies: `AcUnit`, `Add`, `ArrowBack`, `ArrowForward`, `Casino`,
`Close`, `Cloud`, `ContentCopy`, `Dehaze`, `DeleteOutline`, `FilterDrama`, `GitHub`, `Grain`, `Instagram`,
`LinkedIn`, `MusicNote`, `NightsStay`, `NorthEast`, `Pause`, `Place`, `SportsEsports`, `Thunderstorm`,
`WarningAmber`, `WaterDrop`, `WbSunny`, `YouTube`.

- [ ] **Step 1: Write the failing test**

Create `ui/icons/icons.test.tsx`:

```tsx
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import * as icons from './index'

const EXPECTED = [
    'AcUnit', 'Add', 'ArrowBack', 'ArrowForward', 'Casino', 'Close', 'Cloud', 'ContentCopy', 'Dehaze',
    'DeleteOutline', 'FilterDrama', 'GitHub', 'Grain', 'Instagram', 'LinkedIn', 'MusicNote', 'NightsStay',
    'NorthEast', 'Pause', 'Place', 'SportsEsports', 'Thunderstorm', 'WarningAmber', 'WaterDrop', 'WbSunny',
    'YouTube',
]

describe('the icons', () => {
    it('replaces every one the app imports from MUI', () => {
        expect(Object.keys(icons).sort()).toEqual([...EXPECTED].sort())
    })

    it('are decorative by default, so they are not read out beside their own label', () => {
        const { container } = render(<icons.Close />)
        expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    })

    it('become an image with a name when given a title', () => {
        const { container } = render(<icons.Close title="Close" />)
        const svg = container.querySelector('svg')
        expect(svg).not.toHaveAttribute('aria-hidden')
        expect(svg).toHaveAttribute('role', 'img')
        expect(svg).toHaveAccessibleName('Close')
    })

    it('take their colour from the text around them', () => {
        const { container } = render(<icons.Close />)
        expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run ui/icons/icons.test.tsx`
Expected: FAIL, cannot resolve `./index`.

- [ ] **Step 3: Write the wrapper**

Create `ui/icons/Icon.tsx`:

```tsx
import type { ReactNode } from 'react'

export type IconProps = {
    size?: number
    title?: string
}

// One wrapper, so every icon is the same size, takes its colour from the text, and is invisible to a screen
// reader unless it is the only thing carrying the meaning.
export function Icon({ size = 20, title, children }: IconProps & { children: ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            role={title ? 'img' : undefined}
            aria-hidden={title ? undefined : 'true'}
            aria-label={title}
            focusable="false"
        >
            {children}
        </svg>
    )
}
```

- [ ] **Step 4: Write the icons**

Create `ui/icons/index.tsx`. Each icon is the `Icon` wrapper around one or more paths. Take each path from
the Material Symbols outlined set, which is what `@mui/icons-material` draws, so nothing changes visually.
Two examples, to be followed for the remaining 24:

```tsx
import { Icon, type IconProps } from './Icon'

export const Close = (props: IconProps) => (
    <Icon {...props}>
        <path d="M6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6z" />
    </Icon>
)

export const WarningAmber = (props: IconProps) => (
    <Icon {...props}>
        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </Icon>
)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/icons/icons.test.tsx`
Expected: PASS, four tests. The first will name any icon still missing.

- [ ] **Step 6: Commit**

```bash
git add ui/icons
git commit -m "Add our own icons, replacing the MUI icon package"
```

---

### Task 10: The foundation is sound

**Files:** none

- [ ] **Step 1: Run everything**

```bash
npx vitest run && npm run build && npm run wallpaper && npm run lint && npx tsc --noEmit
```

Expected: all pass. Nothing in the app has changed yet, so the build output should be as it was apart from
the second font.

- [ ] **Step 2: Check no component reached for a hex**

Run: `grep -rnE "#[0-9a-fA-F]{3,8}" ui/ --include=*.module.css`
Expected: matches only inside `rgba(...)` alpha values in `Chip.module.css` and `Callout.module.css`, and
nothing in any other stylesheet. Every solid colour should be a `var(--token)`.

- [ ] **Step 3: Commit anything outstanding**

```bash
git status
```

Expected: clean.

---

### Task 11: Somewhere to look at them

Ten tasks built components and never put one on screen. Every test above can pass while a focus ring is
invisible, a Field's error crowds its input, or an amber Chip is unreadable on the panel colour. This is the
task that makes them visible.

It lives at `/admin/ui`, behind the sign-in that already exists: `middleware.ts` matches `/admin/:path*`,
`requireAdmin()` is the second layer every admin page already uses, and `scripts/wallpaper.mjs` already
excludes `app/(admin)` from the static export, so nothing there needs changing. A development-only route was
rejected for the reason the quote spec gives for rejecting a development sign-in bypass: a switch that can be
left on will be.

**Files:**
- Create: `app/(admin)/admin/ui/page.tsx`
- Create: `app/(admin)/admin/ui/gallery.tsx`
- Create: `app/(admin)/admin/ui/gallery.module.css`

**Interfaces:**
- Consumes: every component built in Tasks 4 to 9
- Produces: nothing other tasks depend on

**No test.** A test asserting that a gallery renders a gallery is theatre. Its whole purpose is to be looked
at, and the verification step below is a person looking at it. An import that breaks fails `npm run build`
anyway.

- [ ] **Step 1: Write the page**

Create `app/(admin)/admin/ui/page.tsx`:

```tsx
import type { Metadata } from 'next'
import { Container } from '@mui/material'

import { requireAdmin } from '@/server/auth'
import AdminHeader from '../header'
import Gallery from './gallery'

export const metadata: Metadata = { title: 'UI', robots: { index: false, follow: false } }

export default async function UiGallery() {
    await requireAdmin()
    return (
        <Container maxWidth="lg" sx={{ pb: 6 }}>
            <AdminHeader />
            <Gallery />
        </Container>
    )
}
```

- [ ] **Step 2: Write the gallery**

Create `app/(admin)/admin/ui/gallery.tsx`. Dialog and Tabs hold state, so this is a client component.

```tsx
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
```

- [ ] **Step 3: Write the stylesheet**

Create `app/(admin)/admin/ui/gallery.module.css`:

```css
.gallery { display: grid; gap: 28px; padding-bottom: 40px; }

.lead { color: var(--ink-3); font-size: 13px; max-width: 70ch; margin: 0; }

.row { border-top: 1px solid var(--rule); padding-top: 18px; }

.title { font-size: 15px; font-weight: 600; margin: 0 0 4px; }

.note { color: var(--ink-3); font-size: 12.5px; margin: 0 0 14px; max-width: 70ch; }

.items { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }

.items > * { min-width: 0; }

.icon { color: var(--ink-2); display: inline-flex; }
```

- [ ] **Step 4: Look at it**

Run `npm run dev` and open `http://localhost:3000/admin/ui`. Signing in is required, so this is also a check
that the route is actually protected.

Go through it deliberately:
- Tab through the buttons. Is the focus ring visible on the primary one, where the background is lake blue?
- Click each Field label. Does the input take focus?
- Does the error text crowd the input, or sit clear of it?
- Open the dialog, press Escape, and check focus returns to the button that opened it.
- Focus a tab and arrow left from the first one. Does it wrap to the last?
- Is the amber Chip readable on the panel colour, at 11px?
- Turn on reduced motion in the OS and reload. Does the deploying dot stop pulsing?
- Is any icon visibly heavier or lighter than its neighbours?

Fix what looks wrong in the component, not in this page. Anything fixed here is a component bug that every
future screen would have inherited.

- [ ] **Step 5: Check the build and the export**

Run: `npm run build && npm run wallpaper && npm run lint && npx tsc --noEmit`
Expected: all pass. The wallpaper export already skips `app/(admin)`, so it should not see this page at all.

- [ ] **Step 6: Commit**

```bash
git add "app/(admin)/admin/ui"
git commit -m "Add a gallery of the UI components at /admin/ui"
```

**Two things this task cannot show yet, recorded so they are not mistaken for omissions:**

**Density.** `ui/tokens.ts` exports the `operator` and `client` scales, but no component reads them, so two
columns at different densities would render identically. The comparison belongs in the conversion plan,
where density is actually wired, and the gallery gains a second column then.

**Life without MUI.** This page renders inside the admin layout, so MUI's `CssBaseline` is still applying its
own resets underneath. That is honest for now, because every screen during the conversion renders that way
too, but the gallery needs looking at again once MUI is removed, in case a component was quietly relying on
a reset it no longer gets.

---

## Self-review notes

**Spec coverage.** The spec's component table lists `Button`, `Field`, `Dialog`, `Table`, `Tabs`,
`SegmentedControl`, `Menu`, `Chip`, `Callout`, `Tooltip` and the portal-specific set. This plan builds
`Button`, `Field`, `Dialog`, `Tabs`, `Chip`, `Callout`, `StatusDot` and the icons. **`Table`,
`SegmentedControl`, `Menu`, `Tooltip`, `Meter`, `LogPane`, `Trail` and `KeyValue` are deliberately not
here**: `Table` and the portal-specific four have no consumer until the portal screens exist, and
`SegmentedControl`, `Menu` and `Tooltip` have two uses between them in the whole app. Building them now
would be guessing at their API. They belong in the conversion plan, where the calling code is known.

**Density.** `ui/tokens.ts` exports the `Density` type, but no component reads it yet. The switch is applied
by a layout element, which is the conversion plan's work. Recorded here so it is not mistaken for an
omission.
