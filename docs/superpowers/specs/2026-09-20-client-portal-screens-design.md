# Client portal screens design

Date: 2026-09-20
Status: mockups reviewed, no implementation

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

**Downloads are a selling point, not a footnote.** The section is headed "Your site is yours" and says a copy of
anything can be taken at any time without asking, and that this is everything another developer would need. For a
freelancer that is a differentiator worth the room.

## Where the mockups run ahead of hostd

The screens were drawn from the brief, not from `2026-09-20-hostd-design.md`. Several things they show have no
backend designed for them. Recorded here so the gap is deliberate rather than discovered during implementation.

| The screens show | hostd today |
| --- | --- |
| Deploys on every push, build history, one click rollback, a maintenance page | Nothing. hostd has no concept of git, builds or deploys. This is a whole new phase, or a separate service. |
| Two environments per site, each with its own branch, folder, domain and containers | The registry holds one project per site: one `dir`, one `compose`, one `upstream`. Either every site becomes two registered projects, or the registry grows environments. |
| Editing a site's `.env` from the site page | Explicitly out of scope: "Editing the registry, compose files, `.env` files or source code through the service". A client who can edit anything compose reads, then press start, is root, so if this is built it must be admin only and must not weaken the storage guard. |
| A client downloading their source and settings file | Backups deliberately exclude the compose file, `.env` and source, reasoning that a downloaded backup must not carry the operator's secrets. See the open question below. |
| Server health: system disk, memory, CPU | Health reports backup disk free, stale offsite copies, invalid projects, failed Apache reloads. Memory, CPU and system disk are a small addition. |
| The holding page for a site that is down, not only one mid-deploy | The vhost template proxies to the upstream, so a stopped container gives Cloudflare a 502. Serving the holding page instead is an `ErrorDocument` decision in the same template hostd already owns. |
| "Set this one up" turning a won quote into a client and a site | The registry is hand edited and the service never writes it, on purpose. Creating a site stays an operator step; the portal can at most prepare the client account and hand Koda the registry entry to paste. |

## Open questions

1. **Client downloads of source and the settings file.** The brief asks for them; the hostd design rules them out.
   The mockups follow the brief and resolve it by keeping both out of backups while offering the settings file as
   its own separate download carrying an explicit warning, never bundled into anything. If hostd's rule wins
   instead, the section loses two rows and becomes "Your files and data".
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
