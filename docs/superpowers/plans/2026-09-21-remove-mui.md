# Remove MUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every page off MUI onto `ui/`, then remove `@mui/material`, `@mui/icons-material`, `@mui/material-nextjs`, `@emotion/react`, `@emotion/styled` and `@emotion/cache`, so the whole product is one look instead of navy MUI inside a Readout shell.

**Architecture:** Page by page, each a commit that leaves the app building. The providers come out last, after the final page stops needing them. The landing scene is converted with the same care as everything else but is checked separately, because it is the one page with a performance tier system depending on its CSS.

**Tech Stack:** TypeScript, React 18, Next.js 15 App Router, CSS modules, vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-ui-library-design.md`

## Global Constraints

- **No em dashes** (U+2014) anywhere: code comments are the only exception, per `CLAUDE.md`.
- **House style:** four-space indent, no semicolons, single quotes, named exports.
- **Every colour is a token**, enforced by `ui/palette.test.ts` over `ui/` and expected of every page stylesheet too. Use `color-mix(in srgb, var(--token) 35%, transparent)` for a tint.
- **Change what a page looks like, never what it does.** No copy rewrites, no reordering, no "while I am here". A conversion that also changes behaviour cannot be reviewed against the original.
- `tailwind.config.ts` keeps `important: true`, and the perf rules in `app/globals.css` are not touched. The landing scene's own CSS modules are not touched.
- Tests run with `npx vitest run`. `npm run wallpaper` must pass at every step, and is the check most likely to catch a mistake quietly.

## The mapping

Counted from the source. Roughly 380 MUI element uses across the app, and all but six of them map onto something that already exists.

| MUI | Uses | Becomes |
| --- | --- | --- |
| `Button`, `IconButton` | 84 | `ui/Button`, with an icon child for the icon form |
| `Typography` | 72 | a real heading or paragraph, styled by the page's module |
| `Table` and its six parts | ~100 | `ui/DataTable` |
| `Stack`, `Box`, `Container` | 85 | flex or grid in the page's own CSS module |
| `Link` | 25 | `next/link`, styled |
| `Paper` | 23 | a panel class in the page's module |
| `Chip` | 22 | `ui/Chip` |
| `Alert` | 19 | `ui/Callout` |
| `Dialog` and its three parts | 38 | `ui/Dialog` |
| `TextField` | 25 | `ui/Field` |
| `Divider` | 4 | a border in CSS |
| **`Tooltip`** | **3** | **nothing exists.** Task 1 |
| **`Select`, `MenuItem`** | **3** | **nothing exists.** Task 1 |

---

### Task 1: The two gaps

Everything else has a home. These two do not, and finding that out halfway through converting the quote
inbox is how a conversion stalls.

**Files:**
- Modify: `ui/Field/Field.tsx`, `Field.module.css`, `Field.test.tsx`
- Decide and record: what replaces `Tooltip`

- [x] **Step 1: Give `Field` a select**

`Select` and `MenuItem` appear three times, all as a status picker. Add `as="select"` to `Field` beside its
existing `as="textarea"`, taking its options as children.

Write the test first, and assert the thing that actually matters: that the label is tied to the select, and
that changing it fires `onChange` with the chosen value. The existing label and error wiring must keep
working, so add a case for a select with an error.

- [x] **Step 2: Replace `Tooltip`, do not rebuild it**

All three uses are a hover explanation on an icon: in the quote inbox, a warning mark meaning an email was
not sent. A tooltip is the wrong answer there twice over, because it is invisible on a touch screen and it
hides the meaning behind a hover.

**Replace each with visible text or an accessible name**, whichever fits. The warning mark becomes an icon
with a `title` prop, which `ui/icons` already supports and which gives it an accessible name, beside text
where there is room.

Record in the PR which of the three you changed and how. Do not build a `Tooltip` component: three uses
that should not have been tooltips do not justify one.

- [x] **Step 3: Confirm and commit**

Run: `npx vitest run ui/ && npm run build && npx tsc --noEmit`

```bash
git add ui/Field
git commit -m "Give Field a select, so the conversion has no gaps"
```

---

### Task 2: The gallery

Start here. It is the smallest, it already uses `ui/` for everything it shows, and its only MUI is the page
frame.

**Files:**
- Modify: `app/(portal)/portal/ui/page.tsx`, and add a CSS module beside it

- [x] **Step 1: Convert it**

`Container` becomes a wrapper with a max width and the page's side padding. `AdminHeader` stays for now:
the header is converted in Task 6, when every page that uses it changes at once.

- [x] **Step 2: Confirm and commit**

Run: `npm run build && npm run wallpaper && npx tsc --noEmit`

```bash
git add "app/(portal)/portal/ui"
git commit -m "Convert the gallery off MUI"
```

---

### Task 3: The client pages

**Files:**
- Modify: `app/(portal)/portal/clients/page.tsx`, `[id]/page.tsx`, `new/page.tsx`, `controls.tsx`, and a CSS module per page

- [x] **Step 1: Convert the list**

The table becomes `ui/DataTable`. Read its props from `ui/DataTable/DataTable.tsx`: it takes `label`,
`columns` and `rows`, and it renders a `<p>` rather than headers over nothing when `rows` is empty, so the
page's own empty state can go.

State chips become `ui/Chip`. `STATE_COLOURS` in `clients/state.ts` maps to MUI colour names; map those to
`ui/Chip`'s tones (`good`, `warn`, `crit`) instead. **`state.test.ts` covers that mapping, so change the
test with it rather than around it.**

- [x] **Step 2: Convert the detail and new pages**

`TextField` becomes `ui/Field`, `Alert` becomes `ui/Callout`, `Dialog` becomes `ui/Dialog`. `controls.tsx`
holds the client components, so its `'use client'` stays.

- [x] **Step 3: Confirm and commit**

Run: `npx vitest run && npm run build && npm run wallpaper && npx tsc --noEmit`

```bash
git add "app/(portal)/portal/clients"
git commit -m "Convert the client pages off MUI"
```

---

### Task 4: The quote pages

The densest, and the most used. Convert last of the operator pages.

**Files:**
- Modify: `app/(portal)/portal/quotes/page.tsx`, `[id]/page.tsx`, `[id]/controls.tsx`, `../format.ts`, and a CSS module per page

- [x] **Step 1: Convert the inbox**

The table becomes `ui/DataTable`. `STATUS_COLOURS` in `format.ts` maps to MUI colour names; map to
`ui/Chip` tones as in Task 3.

The warning mark for an unsent email is the `Tooltip` from Task 1. It becomes an icon with a `title`, and
the row keeps its meaning without a hover.

- [x] **Step 2: Convert the quote page**

`Dialog` becomes `ui/Dialog` for the delete confirmation. The status picker is `Field` with `as="select"`
from Task 1. Notes become `ui/Row`s.

**The server actions do not change.** `actions.ts` is untouched by this task; only what renders them moves.

- [x] **Step 3: Confirm and commit**

Run: `npx vitest run && npm run build && npm run wallpaper && npx tsc --noEmit`

```bash
git add "app/(portal)/portal"
git commit -m "Convert the quote pages off MUI"
```

---

### Task 5: The client auth flows

Sign-in, the code step, forgot, invite, reset, setup and account. About 120 MUI uses, mostly `TextField`,
`Button`, `Typography` and `Paper`, in `forms.tsx` and the pages around it.

**Files:**
- Modify: `app/(portal)/portal/forms.tsx`, `sign-in/`, `sign-in/code/`, `forgot/`, `invite/[token]/`, `reset/[token]/`, `setup/`, `account/`, `header.tsx`

- [x] **Step 1: Write a test for each flow before converting it**

These shipped recently and work, and nothing covers what a person actually does with them. Before touching
a page, add a render test: submit empty, submit wrong, submit right, and the error text that appears.

**This is the task's real work.** The conversion itself is mechanical; the risk is a TOTP or recovery-code
flow quietly changing behaviour, and only a test written against the current behaviour can catch that.

- [x] **Step 2: Convert them**

`TextField` to `ui/Field`, `Alert` to `ui/Callout`, `Paper` and `Box` to CSS. These pages sit outside the
`Shell`, so each keeps its own centred layout.

- [x] **Step 3: Confirm and commit**

Run: `npx vitest run && npm run build && npm run wallpaper && npx tsc --noEmit`

```bash
git add "app/(portal)/portal"
git commit -m "Convert the client auth flows off MUI"
```

---

### Task 6: The headers, and the operator sign-in

**Files:**
- Modify: `app/(portal)/portal/adminHeader.tsx`, `header.tsx`, `app/(admin)/admin/sign-in/page.tsx`

- [x] **Step 1: Convert both headers**

They are small and every page that uses them is already converted, so they change together.

Consider whether `adminHeader` should still exist. Every operator page now renders inside `ui/Shell`, which
has its own bar. If a page shows both, one of them goes, and that is a judgement to make with the pages in
front of you. Say which you chose in the PR.

- [x] **Step 2: Convert the operator sign-in**

`app/(admin)/admin/sign-in/page.tsx` is the last MUI page and the reason the admin layout and theme still
exist. Convert it, then delete `app/(admin)/admin/layout.tsx` and `app/(admin)/admin/theme.tsx`, which is
now safe and was not before.

- [x] **Step 3: Confirm and commit**

Run: `npx vitest run && npm run build && npm run wallpaper && npx tsc --noEmit`

```bash
git add app "app/(admin)"
git commit -m "Convert the headers and the operator sign-in"
```

---

### Task 7: The landing page and the wallpaper

The public pages use MUI lightly: a `ThemeProvider`, a `Typography`, and icons. Converting them removes
emotion's runtime from the landing bundle, which helps the scene rather than threatening it.

**Files:**
- Modify: `app/(landing)/parallax/index.tsx`, `app/(landing)/page.tsx`, `app/(landing)/logo/index.tsx`, `app/wallpaper/page.tsx` and its three components
- Delete: `themes/dark.ts`

- [x] **Step 1: Replace the icons**

These pages use MUI icons. `ui/icons` already has all 26, generated from the installed package, so they are
the same drawings. Swap the imports.

- [x] **Step 2: Remove the providers and the theme**

`themes/dark.ts` is a MUI theme used only by the landing parallax and the wallpaper page. With the icons
swapped and `Typography` replaced by a real element, both `ThemeProvider` wrappers and the theme file go.

**Do not touch anything else in these files.** The parallax components, the perf tier attributes and the
scene's CSS modules are not part of this.

- [x] **Step 3: Check the scene, carefully**

Run `npm run dev` and open the landing page. Compare against production or against a build from before this
task:
- The scene still animates, and the parallax still tracks the scroll.
- The perf tiers still apply. Check `?debug=perf` still does what `app/perf/debug.tsx` says it does.
- The logo, the social icons and the weather icons on the wallpaper page all render, at the same weight.

Then `npm run wallpaper` and open the exported build. The wallpaper page is the one most likely to break
quietly, because nothing else exercises it.

- [x] **Step 4: Confirm and commit**

Run: `npx vitest run && npm run build && npm run wallpaper && npm run lint && npx tsc --noEmit`

```bash
git add app themes
git commit -m "Convert the landing page and wallpaper off MUI"
```

---

### Task 8: Take the dependencies out

**Files:**
- Modify: `package.json`, `app/(portal)/layout.tsx`
- Delete: `app/(portal)/theme.tsx`

- [x] **Step 1: Prove nothing imports MUI**

Run: `grep -rn "@mui\|@emotion" app/ server/ ui/ themes/ scripts/ --include=*.ts --include=*.tsx`
Expected: nothing. If anything remains, convert it before going further. Do not remove a package that is
still imported and hope the build tells you.

- [x] **Step 2: Remove the providers**

`app/(portal)/layout.tsx` still wraps everything in `AppRouterCacheProvider` and `PortalTheme`. Both go, and
`app/(portal)/theme.tsx` is deleted with them. Keep the layout's `metadata` and its `force-dynamic`, which
are not MUI's and still matter.

- [x] **Step 3: Remove the packages**

```bash
npm uninstall @mui/material @mui/icons-material @mui/material-nextjs @emotion/react @emotion/styled @emotion/cache
```

- [x] **Step 4: Confirm, and look at the size**

Run: `npx vitest run && npm run build && npm run wallpaper && npm run lint && npx tsc --noEmit`

Record the landing page's first-load JS from the build output, before and after, in the PR. That number is
the only measurable thing this whole plan produces, and it is worth knowing.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "Remove MUI and emotion"
```

---

### Task 9: Look at all of it

Every page, signed in as both roles, at desktop and phone width. `/portal`, a site, quotes, a quote,
clients, a client, new client, the gallery, both sign-ins, and the landing page.

The thing to look for is not "does it work" but "does it look like one product". A page converted in
isolation can pass its tests and still be the odd one out.

Record what you found in the PR, fixed or not.

**Not done.** This branch was built without a `.env`, and both sign-ins need one: the operator's is Google
OAuth and the client's needs a database. Everything reachable signed out was looked at, at desktop and phone
width (the landing page, the wallpaper and its exported build, `/quote`, both sign-in pages, forgot), and
`?debug=perf` was checked against what `app/perf/debug.tsx` documents. The pages behind a session, which is
most of what this task is about, were not. Left unticked on purpose rather than claimed.

---

## What this plan does not do

**It does not change any copy, any behaviour or any server action.** If a page's wording is wrong, that is a
separate change and a separate review.

**It does not restyle the landing scene.** Its colours stay its own, its CSS modules are untouched, and the
only thing that changes there is which library draws its icons.
