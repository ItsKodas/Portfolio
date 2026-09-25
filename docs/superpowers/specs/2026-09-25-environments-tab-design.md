# Environments tab

Date: 2026-09-25
Status: approved design, not yet implemented
Builds on: named environments (PR #125) and copying live's data (PR #128)

## Why

Setting up a branch site today means visiting four places: Settings (add, delete, restore, copy), the
Domains tab (its address), the Environment tab (its env files) and the Deploys tab. This puts everything
about an environment in one tab, and makes an address part of creating one.

## Tabs

Before: Overview, Logs, Environment (admin), Deploys, Backups, Domains, Settings (admin).
After: Overview, Logs, **Environments**, Deploys, Backups, Settings (admin).

- The Domains and Environment tabs are removed. `?tab=domains` and `?tab=env` fall back to the
  Environments tab (keeping `env=`), so old links still land somewhere useful.
- The Environments tab is always shown, to admins and clients (clients read-only, below). A section whose
  capability is off (`domains` for Domains, `env` for Env files) shows the existing "not switched on"
  sentence instead of its panel.

## The Environments tab

Layout: a list of the site's environments (live first, then the others in registry order), and the
selected environment's detail beside it. Selection is `?tab=environments&env=<name>`, defaulting to live;
an unknown name falls back to live. On a narrow screen the list sits above the detail.

List:

- Each row: name, branch, and a small status (deployed commit short hash, or "not deployed").
- Admin only, under the list: **Add environment** (opens the add form in the detail area), then
  **Deleted environments** with days left and Restore (today's Settings section, moved).

Detail for the selected environment, in sections:

1. **Summary.** Branch, last deployed commit, port (admin), and, for a non-live environment, the last copy
   run's status. Admin actions for a non-live environment: **Copy data from live** (today's confirm) and
   **Delete** (today's confirm). Both move here from Settings unchanged.
2. **Domains.** Today's Domains tab panel, scoped to this environment: its main address, aliases,
   verification state, add and remove alias, verify. For live, changing the main address is no longer here
   (see Settings); the main address is shown with a note pointing to Settings. For any other environment
   the main address is set when it is created and is shown read-only here.
3. **Env files.** Today's Environment tab panel, scoped to this environment. Admin only; the section is not
   rendered for clients.

The Deploys tab keeps its own environment dropdown and is unchanged.

## Adding an environment

The add form (admin) replaces the one in Settings:

- **Name** and **Branch**, as today.
- **Address**, required:
  - **Base**: a select of `horizons.gg` and the site's live primary domain. The primary domain option is
    absent when live has no primary domain.
  - **Prefix**: one DNS label (`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`). Pre-filled from the name: for
    `horizons.gg`, `<env>-<site id>`; for the primary domain, `<env>`. Editing the name updates the
    prefix until the prefix is edited by hand.
  - The full hostname is shown as it will be created.
  - A note: the name must resolve to the dedi in DNS before its certificate and site will work; hostd does
    not create DNS records.
- **Start with a copy of live's data**, as today.

## hostd: an address is required

- `parseAddEnvironmentBody` (api) and `parseProvisionAddEnvironment` (protocol) require `domain` to be a
  hostname; `null` or absent is refused with "an environment needs an address".
- `addEnvironment` (agent) refuses, before any disk work, a domain that is not exactly one label below
  either `horizons.gg` or the project's live primary domain, with a message naming both allowed bases.
  Only one label: `uat1.clientsite.com` is allowed, `a.b.clientsite.com` is not. The existing registry
  rules still apply after this (a name under horizons.gg must be covered by `openSubdomains`, reserved
  names are refused, a name used elsewhere is refused).
- The base `horizons.gg` is a constant beside the reserved defaults (`DEFAULT_RESERVED`), not configurable
  here.
- Everything else about add-environment is unchanged; the vhost is written at creation, as it is already
  whenever a domain is given.

## Settings

- Gains **Primary domain** for live: shows live's main address and sets or changes it, using the same
  actions and confirmations the Domains tab uses today (`setPrimaryDomainAction`,
  `changePrimaryDomainAction`).
- Loses the Environments section (moved to the Environments tab).
- Everything else is unchanged.

## Clients

The Environments tab for a client shows the list and, per environment, the Summary (without port and admin
actions) and the Domains section exactly as the Domains tab shows it to them today. No env files, no add,
delete, restore or copy. hostd's policy is unchanged: every admin action is still refused for a client on
the server.

## Components

- `environmentsTab.tsx` (new): the list and detail layout, server component, reads the selection.
- Today's `domainsPanel.tsx`, `env.tsx`/`envForm.tsx`, and `environments.tsx` pieces are reused as
  sections, not rewritten; `environments.tsx` loses its table form in favour of the list and detail.
- `envSwitcher.tsx` stays for the Deploys tab.
- `page.tsx`: the new tab list, the fallback for old tab ids, and loading only what the selected tab and
  environment need (as today: the domains read only when the Environments tab is open).
- `settings.tsx`: the Primary domain section.

## Testing

- hostd: add-environment refuses a missing domain, a domain under neither base, and two labels below a
  base; accepts one label below each base.
- Portal: the tab list for admin and client; old tab ids falling back; environment selection and unknown
  names; the add form's base choices (with and without a primary domain), prefix pre-fill and hand edits,
  the full hostname shown, required address; each detail section present or absent for admin and client;
  Settings' Primary domain section; Settings no longer showing environments.
