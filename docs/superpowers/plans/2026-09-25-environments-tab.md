# Environments Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Environments tab holds each environment's summary, domains and env files, and adding an environment requires an address under horizons.gg or the site's primary domain.

**Architecture:** hostd gains a required, base-checked domain on add-environment (Task 1, parallel worktree). The portal gets a new list-and-detail Environments tab that reuses today's domains, env-file and environments pieces, removes the Domains and Environment tabs, and moves live's primary domain into Settings (Tasks 2 and 3, sequential on the main branch).

**Tech Stack:** TypeScript, Node 22 test runner for hostd; Next.js 15 app router with vitest for the portal.

**Spec:** `docs/superpowers/specs/2026-09-25-environments-tab-design.md`

## Global Constraints

- Allowed address bases: the literal `horizons.gg`, and the project's live primary domain. Exactly one DNS label below a base: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`.
- Pre-filled prefix: `<env>-<site id>` for `horizons.gg`, `<env>` for the primary domain.
- Missing domain refusal text: "an environment needs an address".
- Tabs: Overview, Logs, Environments, Deploys, Backups, Settings (admin). `?tab=domains` and `?tab=env` fall back to `environments`, keeping `env=`.
- Selection: `?tab=environments&env=<name>`, default and fallback `live`.
- Clients: read-only list, Summary without port and admin actions, Domains as they see it today; no env files, add, delete, restore or copy.
- No em dashes (U+2014) in UI copy, docs or commit messages. Check with a Python script file using `chr(0x2014)`.
- Commits: subject, blank line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, via `git commit -F <file>`.
- hostd: `cd hostd && npm test`, `npm run typecheck`. Portal: `npx vitest run`, `npx tsc --noEmit` at the repo root (12 baseline image-import errors; add none).

## Planning decision

- As in the earlier pieces, tasks are specified by interface, behaviour and required tests against the existing code, not full code.

---

### Task 1 (parallel worktree): hostd requires an address

**Files:**
- `hostd/src/shared/protocol.ts` (`parseProvisionAddEnvironment`)
- `hostd/src/api/routes.ts` (`parseAddEnvironmentBody`)
- `hostd/src/agent/provision.ts` (`addEnvironment`)
- `hostd/src/shared/registry.ts` or `hostnames.ts` (a `HORIZONS_BASE = 'horizons.gg'` constant beside `DEFAULT_RESERVED`)
- `hostd/RUNBOOK.md` (the adding section)
- their tests

**Produces:**
- `domain` is required on both parsers; `null` or absent is refused with the Global Constraints text.
- In `addEnvironment`, before any disk work, the domain must be exactly one label below `HORIZONS_BASE` or below live's `domain`. Otherwise refuse with "<domain> must be one label below horizons.gg or <live domain>". When live has no domain, name only horizons.gg.
- The existing checks (openSubdomains, reserved, taken) still run afterwards.

**Required tests:**
- A missing or null domain is refused at the api and in protocol.
- `uat1-acme.horizons.gg` and `uat1.clientsite.com` are accepted.
- `a.b.clientsite.com`, `uat1.other.com` and `horizons.gg` itself are refused.
- A live with no primary domain accepts only horizons.gg.

**Commit:** "Require an address under horizons.gg or the site's domain for a new environment"

### Task 2: The Environments tab

**Files:**
- `app/(portal)/portal/sites/[id]/page.tsx`: the tab list, old ids falling back, loading data for the new tab.
- `environmentsTab.tsx` (new): the list and the detail.
- `environments.tsx`: rework the table into a list plus detail sections (Summary, and the copy and delete actions); deleted environments go under the list.
- Reuse `domainsPanel.tsx` and `domainControls.tsx` as the Domains section.
- Reuse `env.tsx` and `envForm.tsx` as the Env files section.
- `site.module.css`.
- Remove what becomes dead: the Domains and Environment tab wiring, and `EnvSwitcher` use outside Deploys.
- Tests beside each.

**Produces:**
- The tab ids become `overview`, `logs`, `environments`, `deploys`, `backups`, `settings`.
- `EnvironmentsTab({ view, selected, isAdmin, ... })` renders the list (live first; name, branch, deployed short hash or "not deployed") with links `?tab=environments&env=<name>`. Admins get "Add environment" and the Deleted list under it.
- The detail shows three sections:
  - **Summary:** branch, deployed commit, port (admin), last copy status (non-live). Admin actions for non-live environments: Copy data from live, and Delete.
  - **Domains:** today's panel for that environment. For live, the change-primary controls are replaced by a note pointing to Settings. For non-live environments the primary is read-only.
  - **Env files:** admin only.
- Sections whose capability is off show the existing not-switched-on sentence.
- The add form opens in the detail area when "Add environment" is chosen (`?tab=environments&add=1`). Keep today's add form in this task; Task 3 changes its fields.

**Required tests:**
- The tab list for an admin and for a client.
- `?tab=domains` and `?tab=env` land on Environments with `env=` kept.
- An unknown `env` falls back to live.
- The list rows and links.
- Each section present or absent for admin and client, and for capability on or off.
- Copy and Delete only on non-live rows, and only for an admin.
- The Deleted list moved under the list.
- The live Domains section with no change-primary controls.
- Page data loads only when the Environments tab is open.

**Commits:** coherent steps.

### Task 3: Required address in the add form, and primary domain in Settings

**Files:**
- `environments.tsx` or the new add form component: the address fields.
- `actions.ts`: `addEnvironmentAction` requires `domain` and validates the label and base on the server.
- `server/hostd/environments.ts`: `domain` becomes a required string.
- `settings.tsx`: the Primary domain section, and removing the Environments section.
- Tests.

**Produces:**
- **Add form:**
  - A Base select offering `horizons.gg` and, when live has a primary domain, that domain.
  - A Prefix input, pre-filled per the Global Constraints. It updates from the Name until it is edited by hand.
  - The full hostname shown live.
  - A DNS note.
  - The address is required; the button is disabled until the prefix is valid.
- **The server action** refuses:
  - a missing domain;
  - a prefix that is not a valid label;
  - a base that is neither horizons.gg nor live's current domain, re-read from hostd.
- **Settings Primary domain:** live's main address, with set and change using the existing `setPrimaryDomainAction` and `changePrimaryDomainAction` and their confirmations, admin only. The Environments section is removed from Settings.

**Required tests:**
- **Base options:** with and without a primary domain.
- **Prefix:** pre-fill for each base; a hand edit stops the pre-fill; an invalid label disables submit.
- **Hostname:** the full hostname text.
- **Action:**
  - refuses a missing domain, a bad label and a wrong base;
  - an admin succeeds;
  - a client is refused.
- **Settings:** shows the Primary domain section and its set and change flows, and shows no Environments section.

**Commits:** coherent steps.

### Task 4: Merge and verify

- Merge the Task 1 worktree branch into the main branch.
- Check that the portal's add call sends `domain` in the shape hostd now requires.
- Run all four suites.
- If Master moved, merge it and retest.
