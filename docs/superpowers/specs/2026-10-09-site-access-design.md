# Site access

## Before

A site row in the portal belonged to exactly one client (`Site.clientId`), and hostd's registry held a single
`client:` per project. hostd let a client reach a project only when that field matched, so two clients could
never share a site. The operator reached every site.

## After

- **Sites stand alone.** `Site` has no owner. The operator reaches every site, whoever has access to it.
- **Clients are accounts.** Nothing about a client says which sites it has.
- **`SiteAccess`** joins one client to one site, keyed on `(siteId, clientId)`, with a `permissions` list. Any
  number of clients may share a site. Deleting a client deletes their access and leaves the site. Deleting a
  site deletes everyone's access to it.

## Permissions

Any access shows the site in the client's portal and its Overview (status and what it is made of). Beyond
that, each grant carries some of:

| Permission | What it shows |
| --- | --- |
| `LOGS` | The Logs tab, and the log on the Overview |
| `LIFECYCLE` | Start, stop and restart |
| `ENVIRONMENTS` | The Environments tab: each environment and its domains, read only |
| `DEPLOYS` | The Deploys tab: the history, and a deploy as it runs, never starting one |

These are exactly what a client could do before. Settings, env files, deploying, rollback, branches, domain
changes, environments and deleting a site stay the operator's whatever is granted; hostd enforces the same
line with its admin-only verbs.

The page hides a tab or control a client was not given, and the server checks the same permission again: the
lifecycle action needs `LIFECYCLE`, the log relay needs `LOGS`, the deploy stream needs `DEPLOYS`.

## hostd

The portal sends `X-Hostd-Sites` on every request made for a client: the comma separated project ids they have
access to, read from the portal's database for that request. hostd checks a client against that list and does
not read the registry's `client:` key. A request without the header (an older portal, or the runbook's own
curl calls) falls back to `client:`, so deploying hostd first changes nothing until the portal follows.

hostd does not see the individual permissions. It holds the line it always held (which project, and which
verbs are the operator's), and the portal decides the finer split.

## Managing access

- A site's **Access** tab (operator only): every client with access, their permissions, removing them, and
  giving another client access.
- A client's page: their sites with the same controls, and giving them any site by project id.
- Creating a site with a client picked gives that client access with every permission.

## Migration

`20261009120000_site_access` creates `SiteAccess`, copies every existing `Site.clientId` into it with all four
permissions (what that client could already do), then drops `Site.clientId`. Nothing is lost and nobody
gains anything.
