# Move the admin pages into the portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every page in one place, under `/portal`, so what you can reach depends on who signed in rather than on which URL you remembered.

**Architecture:** A move, not a rewrite. The pages keep their MUI exactly as they are and are converted in a second pass. `/admin` URLs redirect rather than disappearing, because every quote notification email ever sent contains one.

**Tech Stack:** TypeScript, Next.js 15 App Router.

**Spec:** none of its own. It serves the portal design at https://claude.ai/artifact/XLHxrDVisXjvGYTC5Xto3M

## Global Constraints

- **No em dashes** (U+2014) anywhere: code comments are the only exception, per `CLAUDE.md`.
- **House style:** four-space indent, no semicolons, single quotes.
- **Change no page's contents beyond its imports.** This pass moves files and fixes what moving breaks. Every other edit belongs to the conversion, and mixing the two makes both impossible to review.
- Do not touch `ui/`, `server/hostd/` or `app/(landing)`.
- Use `git mv`, so the history follows the file and the diff reads as a move.
- Tests run with `npx vitest run`. `npx tsc --noEmit` is what catches a broken import, so run it after every task.

## The map

| From | To | Why |
| --- | --- | --- |
| `app/(admin)/admin/page.tsx` | `app/(portal)/portal/quotes/page.tsx` | `/portal` is the dashboard now, so the inbox gets its own path |
| `app/(admin)/admin/actions.ts` | `app/(portal)/portal/quotes/actions.ts` | they are the quote actions and belong beside the quote pages |
| `app/(admin)/admin/quotes/[id]/` | `app/(portal)/portal/quotes/[id]/` | unchanged shape |
| `app/(admin)/admin/format.ts` | `app/(portal)/portal/format.ts` | shared by quotes and clients, so it sits above both |
| `app/(admin)/admin/header.tsx` | `app/(portal)/portal/adminHeader.tsx` | **renamed.** `portal/header.tsx` already exists and is the client's header |
| `app/(admin)/admin/clients/` | `app/(portal)/portal/clients/` | unchanged shape |
| `app/(admin)/admin/ui/` | `app/(portal)/portal/ui/` | unchanged shape |
| `app/(admin)/admin/sign-in/page.tsx` | **stays** | `server/auth/config.ts` builds `SIGN_IN_PATH` on it, and it is a standalone page outside any shell |
| `app/(admin)/admin/layout.tsx` | **stays** | it is what gives the sign-in page its MUI providers, see below |
| `app/(admin)/admin/theme.tsx` | **stays** | the layout imports it |

**The layout and theme look deletable and are not.** `sign-in/page.tsx` renders `Alert`, `Box`, `Button`,
`Paper` and `Typography` straight from MUI. Without `app/(admin)/admin/layout.tsx` there is no
`AppRouterCacheProvider` and no `AdminTheme` above it, so it would render in MUI's **default light theme**,
white on white against the site, with a flash of unstyled content on every load. They stay until the
conversion takes MUI out of the sign-in page too, which is when both can go.

This leaves two identical MUI themes in the tree, `(admin)/admin/theme.tsx` and `(portal)/theme.tsx`. That
duplication is known and deliberate for now; do not "fix" it by pointing one route group at the other's
theme.

Every moved page keeps its `requireAdmin()` call. That is what makes them admin-only wherever they live, and it does not change.

---

### Task 1: The quote pages

**Files:**
- Move: `app/(admin)/admin/page.tsx`, `actions.ts`, `format.ts`, `header.tsx`, `quotes/[id]/page.tsx`, `quotes/[id]/controls.tsx`
- Modify: the imports listed below, and nothing else

- [ ] **Step 1: Move the files**

```bash
mkdir -p "app/(portal)/portal/quotes/[id]"
git mv "app/(admin)/admin/page.tsx"              "app/(portal)/portal/quotes/page.tsx"
git mv "app/(admin)/admin/actions.ts"            "app/(portal)/portal/quotes/actions.ts"
git mv "app/(admin)/admin/quotes/[id]/page.tsx"  "app/(portal)/portal/quotes/[id]/page.tsx"
git mv "app/(admin)/admin/quotes/[id]/controls.tsx" "app/(portal)/portal/quotes/[id]/controls.tsx"
git mv "app/(admin)/admin/format.ts"             "app/(portal)/portal/format.ts"
git mv "app/(admin)/admin/header.tsx"            "app/(portal)/portal/adminHeader.tsx"
```

- [ ] **Step 2: Fix exactly four imports**

Most relative imports survive the move because the depth is unchanged. These four do not. Change nothing else.

In `app/(portal)/portal/quotes/page.tsx`:

```
from './format'   ->  from '../format'
from './header'   ->  from '../adminHeader'
```

In `app/(portal)/portal/quotes/[id]/page.tsx`:

```
from '../../header'  ->  from '../../adminHeader'
```

`from '../../format'` in that same file is already correct: from `portal/quotes/[id]/` it resolves to
`portal/format`. Leave it.

In `app/(portal)/portal/quotes/[id]/controls.tsx`:

```
from '../../actions'  ->  from '../actions'
```

- [ ] **Step 3: Rename the component, not just the file**

`adminHeader.tsx` still exports `AdminHeader`. Leave the export name alone: it is accurate, and renaming it
would touch four more files for no benefit in a pass whose whole point is moving.

- [ ] **Step 4: Prove nothing is dangling**

Run: `npx tsc --noEmit`
Expected: clean. A wrong relative path fails here, which is the only reliable check on a move.

Then: `grep -rn "admin/page\|admin/actions\|admin/format\|admin/header" app/ server/ --include=*.ts --include=*.tsx`
Expected: nothing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Move the quote pages into the portal"
```

---

### Task 2: The client pages

**Files:**
- Move: `app/(admin)/admin/clients/` entire
- Modify: three imports

- [ ] **Step 1: Move the directory**

```bash
git mv "app/(admin)/admin/clients" "app/(portal)/portal/clients"
```

- [ ] **Step 2: Fix three imports**

In `app/(portal)/portal/clients/page.tsx`:

```
from '../header'  ->  from '../adminHeader'
```

In `app/(portal)/portal/clients/[id]/page.tsx`:

```
from '../../header'  ->  from '../../adminHeader'
```

In `app/(portal)/portal/clients/new/page.tsx`:

```
from '../../header'  ->  from '../../adminHeader'
```

`../format`, `../../format`, `./state`, `../state` and `../controls` are all still correct at their new
depths. Leave them.

- [ ] **Step 3: Prove it**

Run: `npx tsc --noEmit && npx vitest run "app/(portal)/portal/clients"`
Expected: clean, and `state.test.ts` still passes from its new home. If vitest does not pick the file up, the
`unit` project's `include` already covers `app/**/*.test.ts`, so a miss means the path is wrong rather than
the config.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Move the client pages into the portal"
```

---

### Task 3: The gallery

**Files:**
- Move: `app/(admin)/admin/ui/` entire
- Modify: one import

- [ ] **Step 1: Move it**

```bash
git mv "app/(admin)/admin/ui" "app/(portal)/portal/ui"
```

- [ ] **Step 2: Fix one import**

In `app/(portal)/portal/ui/page.tsx`:

```
from '../header'  ->  from '../adminHeader'
```

`./emails`, `./gallery` and `./gallery.module.css` are unchanged.

- [ ] **Step 3: Prove it**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Move the component gallery into the portal"
```

---

### Task 4: Redirects, and the link in the emails

The old URLs cannot simply stop working. `server/quotes/emails.ts` puts `/admin/quotes/<id>` in the
notification sent for every quote, so those links are sitting in an inbox right now.

**Files:**
- Modify: `next.config.ts`, `server/quotes/emails.ts`, and that file's test

- [ ] **Step 1: Leave the admin layout and theme alone**

They look like leftovers now that only `sign-in/page.tsx` remains under `(admin)`, and they are not.
That page renders `Alert`, `Box`, `Button`, `Paper` and `Typography` straight from MUI, so without
`AppRouterCacheProvider` and `AdminTheme` above it, it renders in MUI's default **light** theme with a flash
of unstyled content. Deleting them is a visible regression on the one page the operator has to use before
they can reach anything else.

Nothing to do in this step except not do that.

- [ ] **Step 2: Point new emails at the new URL**

In `server/quotes/emails.ts`, change the link built around line 23:

```
`${options.siteUrl}/admin/quotes/${quote.id}`   ->   `${options.siteUrl}/portal/quotes/${quote.id}`
```

Its test asserts on that link. Update the expectation to match, and **do not** weaken the assertion to
something that would pass either way: the point of that test is that the operator gets a working link.

- [ ] **Step 3: Redirect the old URLs**

In `next.config.ts`, add redirects. They must be **conditional on not being the wallpaper build**: a static
export cannot serve a redirect, and `npm run wallpaper` sets `output: 'export'`, so an unconditional
`redirects` breaks that build.

```ts
  // Every quote notification ever sent links to /admin/quotes/<id>, so these cannot simply stop working.
  // Temporary rather than permanent: a 308 is cached by the browser forever, and these paths are still
  // settling. Make them permanent once they are not.
  ...(!wallpaper && {
    async redirects() {
      return [
        { source: '/admin', destination: '/portal/quotes', permanent: false },
        { source: '/admin/quotes/:id', destination: '/portal/quotes/:id', permanent: false },
        { source: '/admin/clients/:path*', destination: '/portal/clients/:path*', permanent: false },
        { source: '/admin/ui', destination: '/portal/ui', permanent: false },
      ]
    },
  }),
```

`/admin/sign-in` is deliberately not in that list. It still exists and must keep working.

- [ ] **Step 4: Prove it**

Run: `npx vitest run && npm run build && npm run wallpaper && npm run lint && npx tsc --noEmit`
Expected: all pass. **`npm run wallpaper` is the one that matters here**: if the redirects were added
unconditionally, it fails with a static export error, which is exactly what the condition prevents.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Redirect the old admin URLs, and point new emails at the portal"
```

---

### Task 5: Reach every page

**Files:** none, unless something is broken.

Only a signed-in operator can do this, and it is the only thing that proves the move worked.

- [ ] **Step 1: Sign in and walk the routes**

With a `.env` present, `npm run dev`, sign in at `/admin/sign-in`, then visit each in turn:

| Visit | Expect |
| --- | --- |
| `/portal` | the dashboard, three zones |
| `/portal/quotes` | the quote inbox |
| `/portal/quotes/<a real id>` | one quote, with its notes and actions working |
| `/portal/clients` | the client list |
| `/portal/clients/<id>` | one client |
| `/portal/clients/new` | the form |
| `/portal/ui` | the gallery |
| `/admin` | redirected to `/portal/quotes` |
| `/admin/quotes/<the same id>` | redirected, landing on the same quote |
| `/admin/sign-in` | still the sign-in page, not a redirect |

- [ ] **Step 2: Sign in as a client and try to get in**

A client visiting `/portal/quotes`, `/portal/clients` or `/portal/ui` must be refused. Each page calls
`requireAdmin()`, which redirects, and that is what to confirm. This is the check worth doing carefully: the
pages moved into a route group whose middleware gate now accepts a client cookie, so `requireAdmin()` is the
only thing standing between a client and the quote inbox.

- [ ] **Step 3: Record what you found**

Anything broken goes in the PR whether or not you fix it. A page that 500s on a real quote is worth more
than a clean build.

---

## What this plan does not do

**It does not convert anything.** Every moved page is still MUI and still navy, inside a portal that is
Readout. That mismatch is expected, was chosen deliberately over converting each page as it moved, and is
what the second pass fixes. Nothing here should be tidied "while we are in there": a move that also changes
appearance is a move nobody can review.

**It does not put the moved pages in the `Shell`.** They keep `AdminHeader`. Wrapping them in the three-zone
shell is conversion work, and doing it here would mean every page renders two headers or none.

**It does not add nav links to them.** The portal's left rail does not yet offer Quotes, Clients or
Components. Adding those is a one-line change per entry in the dashboard's nav, and belongs with whichever
pass makes them look like they belong there.
