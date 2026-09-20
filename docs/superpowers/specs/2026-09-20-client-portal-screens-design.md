# Client portal screens design

Date: 2026-09-20
Status: mockups reviewed, no implementation
Updated: 2026-09-20, reconciled against `2026-09-20-hostd-provisioning-design.md`

## What this is

Clickable mockups of the portal's three screens, built as a private page on claude.ai so they could be clicked
through and reacted to rather than described:

https://claude.ai/artifact/9jMwWRmWYvRHJCmAszJ8rP

Nothing here was implemented. The Next.js app is owned by another session, the data these screens show does not
exist yet, and `hostd/` was not touched. This note records the decisions the drawings encode, and, more usefully,
where they run ahead of what has actually been designed.

The mockups cover Koda's dashboard, a single site's page, the client's own view, and the states these imply: a
deploy in progress, a failed deploy, a site that is down, and the holding page visitors meet while a site
redeploys. Two scenarios run through all of them, a bad Sunday night and the following morning, so each screen can
be judged both when something is wrong and when nothing is.

## Design language

**Split personality.** Both sides share the palette, the typefaces and the vocabulary, and differ in density.
Koda's side is an instrument panel: small rows, tabular figures, status encoded in a rail down the left edge, five
things visible at once. The client's side is roomy: one sentence set large, sections divided by rules rather than
panels, no tables at all. They are different jobs for different people, so hiding fields from one screen to make
the other would have served neither.

**Colour by role, taken from the existing admin theme.** Night `#0b101f`, panel `#111a38`, lake `#8fd4f5` as the
one interactive accent, and status colours kept separate from it: `#6fd39b` up, `#f0b45c` warning, `#f4685f`
critical. The pink `#f19bb3` has exactly one job across every screen: it marks that a person did something, as
opposed to a push or hostd. That is how a client's own actions become legible in Koda's activity feed.

**Montserrat for the interface, IBM Plex Mono for machine text only.** Commit ids, container names, branches, log
lines and file paths are monospaced because they are literally machine output. Labels are not.

**Deliberately single theme.** The site is the night scene and has no light mode, so the page commits to dark and
paints every colour rather than inheriting one.

## The dashboard

Ordered as asked: anything wrong, then a card per site, then activity across all sites, then server health.

**Every alert carries the deploy that preceded it.** ASOT's alert reads `21:06 deployed 5f0ac31`, then
`21:10 web exited 137`, and the primary button is `Roll back to 2e9d44a`. This is the single idea the screen is
built around. At 9pm the question is never only "what broke", it is "what changed just before it broke", and
answering both in the same three lines is what makes rollback findable in a hurry.

**A failed deploy and a bad deploy get different buttons.** A build that never finished left live untouched, so it
offers the build log and a retry, and says plainly that live did not move. A deploy that landed and then killed
the site offers a rollback. Conflating the two would put a destructive action next to a situation that does not
need one.

**The attention band is permanent.** With nothing wrong it collapses to a single green line rather than
disappearing, so the top of the page always means the same thing and the cards never jump.

**Cards are ordered by trouble, not by name**, so a sick site is never below the fold.

## A site's page

**Both environments stay on screen.** Live and test sit side by side at the top and are never behind a tab,
because what is running right now is the question the page exists to answer. The tools below (deploys, logs,
environment) follow whichever environment is selected; backups and domains are not per environment, so the
selector disappears on those tabs.

**Rollback appears in three places, on purpose.** A permanent row at the foot of each environment panel naming the
target commit, an action on every successful row in the deploy history, and, when the site is down, that panel
button promotes itself to the primary style. It is only ever the loudest thing on the page when something is
actually broken.

**The rollback confirmation is the most important copy in the portal.** It shows now against going to, then says
that this puts the code back and nothing else: bookings and form submissions recorded since stay exactly as they
are, and older code may not read a database a newer version reshaped. It also says the branch is not touched, so
the next push still deploys normally. Rolling back is done while panicking, so it has to explain itself.

**Backups admits its gap.** There is no restore button and the page says why: a restore overwrites a live
database on a mis-click, so it stays a manual runbook job until the procedure has been used enough to trust. The
page also says test is not backed up.

## The client's view

**Their words.** No containers, commits, shas, branches or test environment. Recent updates, not deploy history.
Copies, not snapshots. The status is a sentence.

**A failed deploy does not appear at all.** Live never moved, so from the client's side nothing happened. Only
builds that reached live are listed, and a rollback reads as "Put back to an earlier version" rather than
disguising itself as an ordinary change.

**When their site is down, the page tells them to do nothing.** It leads with the fact that Koda already knows and
is looking, and the primary action is to message him. Restart is offered, because clients can restart, but it is
third, because the honest answer is that it is already being handled.

**During a deploy there is no restart button at all.** There is nothing to press that would not make it worse.

**Stop sits behind one extra click** with its consequence written out. Both start and stop are available, as
asked. They are simply not the same size as restart.

**Live logs are framed honestly**, collapsed, and introduced as raw output that nothing in day to day use requires
them to read.

**Downloads are a selling point, not a footnote.** The section is headed "Your site is yours": source code,
uploads and database, taken whenever they like and without asking. For a freelancer that is a differentiator worth
the room. The settings file is the one thing deliberately missing, and the page says so plainly rather than
staying quiet about it, because a gap a client finds for themselves reads worse than one they were told about.

## Where the mockups meet hostd

The screens were drawn from the brief, not from a backend. Since they were drawn,
`2026-09-20-hostd-provisioning-design.md` has settled most of what they assumed. That design had not yet merged
when this section was rewritten against it, though its implementation is already landing in pieces.

### What the provisioning design settles

| The screens show | Where it stands |
| --- | --- |
| Deploys on every push, build history, one click rollback, a maintenance page | All designed. Build into a new copy before swapping, a maintenance flag during the swap, a health check after it, and an automatic return to the previous copy when that check fails. |
| Two environments per site, each with its own branch, folder, domain and containers | Designed. The registry grows an `environments` block with a folder, branch, domain, port and certificate mode each. The single environment shape stays valid and means live only. |
| Editing a site's `.env` from the site page | Designed, operator only, and confined to env files inside one environment's folder so that path can never change code. |
| "Set this one up" turning a won quote into a client and a site | **Now possible.** hostd writes `projects.yaml` itself through a validated `POST /projects`, deriving the id, folders and ports rather than accepting them. The first version of this note said the opposite, on the basis that the registry was hand edited and never written by the service. That is no longer true. |
| A client downloading their settings file | **Decided against, 2026-09-20.** Clients never read env files, in the original hostd design and again in the provisioning design. The mockups no longer offer it, and the client's page says so rather than staying quiet. |
| The holding page for a site that is down, not only one mid-deploy | Designed. Apache serves it when a flag file exists or the upstream cannot be reached, so a planned deploy and an unplanned outage both look tidy, and the page can say which it is. |

### What the mockups get wrong

Found by reading the provisioning design against the drawings. None of it is drawn yet.

- **`rolled-back` is a deploy outcome the screens do not have.** A health check that fails after the swap sends
  hostd back to the previous copy by itself. A site that broke and repaired itself overnight is a different row in
  the deploy history from a build that failed, and a different line in the activity feed.
- **Three consecutive failures pause an environment** and polling stops until the operator acts. That belongs in
  the attention band, and nothing there covers it.
- **Deploys are noticed by polling every two minutes.** The dashboard shows a push and its deploy beginning in the
  same minute, which overstates how quickly the system reacts.
- **A new project stops in `needs-setup`** after cloning, waiting for its env files, rather than arriving running.
  The "Add a site" flow ends one screen too early.
- **The deploy steps are prepare, build, swap, health check.** The progress box invents its own sequence.
- **Env files are per file, not one flat list**: any `.env`-style file in the environment's folder, subfolders
  included, with `.env.example` shown beside each. The Environment tab needs a file picker it does not have.
- **Certificates are per environment**, Let's Encrypt or Cloudflare Origin. The dashboard's certificate alert
  claims every site on the dedi is affected, which is only true of the Origin ones.

### What still has no backend

| The screens show | hostd today |
| --- | --- |
| Server health: system disk, memory, CPU | Health reports backup disk free, stale offsite copies, invalid projects and failed Apache reloads. The rest is a small addition. |
| A client downloading their source code | Not addressed anywhere. Backups exclude source, and general file access (phase 3) covers declared storage directories rather than the repo tree. Still open. |

## Open questions

1. **Client downloads of the settings file. Decided 2026-09-20: no.** Two designs ruled it out independently, and
   the mockups now match. The client's page names the gap instead of hiding it, and says the file is handed over
   directly if they ever move to another developer. Their **source code** is a separate question and is still
   open: nothing has designed it either way.
2. **Client facing update text.** Recent updates currently shows commit messages verbatim. Some read fine to a
   client ("New spring menu PDF") and some do not ("Switch to sharp for thumbnails"). A separate optional field
   for the client facing line may be worth the trouble.
3. **Five tabs on the site page and five alerts on the dashboard.** Both may be one too many. The deploy history
   table is also carrying a lot of columns.
4. **The domains tab.** Not asked for, added because hostd has the feature fully designed and it is clearly a site
   level concern. Confirm it belongs there rather than in a settings area.

## Content in the mockups

Every client name, domain, contact, commit message, log line and figure in the mockups is invented to make the
screens realistic. None of it is real client data, and the domains in particular are guesses.
