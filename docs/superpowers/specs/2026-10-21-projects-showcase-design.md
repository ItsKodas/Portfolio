# Projects showcase and project pages

Date: 2026-10-21. Branch: `claude/next-changes`.

## Why

The home page is Koda's CV as well as the way clients ask for work. There is no separate CV: an employer reads
this page, usually on a phone, and decides from it. Two things fail that reader today:

- The projects grid is a wall of equal cards with text only. Nothing says which work matters most, nothing is
  grouped, and there is nothing to look at.
- Readers miss that Koda built all of it. Koda's dad read the projects section and did not realise the work was
  Koda's own, because the only claim is the heading "Things I've made", which reads as a label.

Koda's background is fullstack web development (years of client sites written by hand), and with AI tools Koda now
builds well beyond the web: desktop apps, a game, a physics engine, mods. The page should show that range and make it
plain that Koda is open both to a job and to contract work.

## Goals

- An employer on a phone can see Koda's strongest work, the range of it, and who built it, within a few scrolls.
- Projects are grouped by kind (websites, apps, games, mods) without hiding any of them behind extra clicks.
- Every project has screenshots (or a deliberate placeholder) and its logo where one exists.
- Anyone who wants more can open a page per project with a gallery, a fuller write-up, the tech and the links.
- The About section says what Koda does now, that Koda is open to work as well as contracts, and how AI fits in.

## Non-goals

- No other repositories. The list is exactly the 11 projects on the site today plus AI Culler (12 in all).
- No downloadable CV, experience timeline or testimonials in this piece of work.
- No CMS or database: projects stay as typed data in the codebase.
- No change to the toolkit section or the quote form. The hero changes already made on this branch (the "My
  Projects" button that glides to `#projects`, its icon, and the note's new wording) ship with this work.

## Anti-goals (a failure even if it works)

- Copy that reads as AI-written: buzzwords ("seamless", "robust", "leverage", "cutting-edge", "passionate"),
  three-adjective lists, vague claims, or anything an interviewer could catch as untrue.
- A per-project "made with AI" badge that reads as a disclaimer.
- A phone layout that is a dozen screens of cards.
- Claims beyond what the repos and READMEs support. Numbers are quoted as the READMEs state them.
- Em dashes anywhere (project rule, CLAUDE.md).
- Slowing the landing page: it is already heavy (see the staged scene tiers spec), so images must be small and lazy.

## Decided with Koda

- **Layout "C": a few featured, then a tidy list.** Chosen from three mockups (filter tabs with a card grid; a
  sideways-swiping row per category; featured plus list).
- **Featured, in this order:** PMPC Group, Spot On Drones, Atomic Sandbox, ASOT Milsim.
- **The 12 projects:** Blastyard, Atomic Sandbox, Voxweave, The Back Room, 1st CANZUK Brigade, ASOT Milsim,
  Tax Assistant, Arby's Auto Glass, Spot On Drones, PMPC Group, Horizons Portfolio (this site), AI Culler.
- **Every project has its own page** behind "Read more", with more screenshots and information.
- **Logos** shown for each project that has one.
- **Screenshots** from Koda's folder `C:\Users\koda\OneDrive\Desktop\screenshots` where they exist, placeholders for
  the rest, replaced later.
- **AI is disclosed once, confidently, in the About section,** not as a label on each card. Koda's split:
  - By hand: Tax Assistant, Spot On Drones, PMPC Group.
  - Both: Arby's Auto Glass (see below); ASOT Milsim (first two years by hand, the last ten months with Claude); this site (about half and half).
  - With Claude: Blastyard, Atomic Sandbox, Voxweave, The Back Room, 1st CANZUK Brigade, AI Culler.
- **The site is the CV.** Getting in touch about a job must be as obvious as "Get a quote" is for a client.
- **Arby's Auto Glass is "both"**: written by hand from 2022, with the 2026 redesign (24 of the rebuild's 43 commits,
  from 2026-09-19) done with Claude. For most of its life it was Koda's hand-written code, and the page says so.
- **PMPC stays featured first.** Its links (project page and the "Worked with" logo strip) point at
  pmpcgroup.horizons.gg, labelled "View my build", since pmpcgroup.com.au now serves a site Koda did not build
  (builder's call on the label, Koda decided to keep it featured).
- **"Email me" goes to koda@horizons.gg, hidden from scrapers:** the address never appears in the HTML. The button
  builds the `mailto:` link in the browser only when clicked (for example from parts joined in the click handler).
- **Koda stays a "Fullstack Developer".** It is Koda's strongest area, so the title under the name, the hero's
  "Fullstack Development", `SITE.role` and `SITE.tagline` stay. The wider range is said in the About text and in
  `SITE.description` (full-stack first, then desktop apps, games and mods), which feeds search snippets and share
  cards. The layout keywords keep "fullstack developer" and may add the other kinds.

## The landing page

### Projects section

Heading, replacing "Things I've made":

> PROJECTS
> **Built by me, start to finish**
> Everything here was designed, built and shipped by me: client websites, web apps, desktop apps, a game and mods.

(The intro line is a draft; see Open questions.)

**Featured (shown only on the "All" view):** four larger cards, 2 x 2 on desktop, stacked on a phone. Each card:

- a screenshot strip (16:9 on desktop; a little shorter on a phone so a card is under one screen tall)
- the logo, overlapping the bottom edge of the screenshot (or a monogram tile if there is no logo)
- name, year, category and a short context label ("Client project", "Personal project" or "Community project")
- one plain sentence
- up to four tech tags
- "Read more" (the whole card is the link; the external links live on the project page, so the card has one target)

**The list:** every non-featured project as a compact row: small thumbnail (about 64 px wide), logo, name, category
and year, one line (truncated to one line on a phone), and a chevron. The whole row links to the project page.

**Category tabs** above the list. A tab appears only if it has a project. With the 12 projects these are: All,
Websites, Web apps, Desktop apps, Mobile apps, Games, Mods. "All" is selected by default and shows the featured cards
plus the list of the rest. Picking a category hides the featured block and lists every project of that kind,
featured ones included, so nothing is missing from a filtered view. Tabs scroll sideways on a phone.

Ordering: featured in the order above; the list by the last year worked on, newest first, then by the first year,
newest first, then by name (builder's call).

Filtering happens in the browser with no page load. The selected tab is not put in the URL (keep it simple). The
"All" view and every project link are in the server-rendered HTML, so crawlers see them (builder's call: the page as a
whole already needs JavaScript, because the parallax wrapper sizes itself from script).

### About section

Rewrite the intro so it says what Koda does now and that Koda is open to work. Draft:

> **Dakoda Lancelot**
> Fullstack Developer
>
> I'm a full-stack developer: I've spent years building websites and web apps for clients, from the database to the
> front end, written by hand. With AI tools in the mix I now build well past the web too: desktop apps, a game and
> mods. I use Claude as part of how I work. I decide what gets built and how it fits together, and I review and test
> everything that ships.
>
> I'm open to full-time roles as well as contract work.
>
> [Get a quote]  [Email me]

"Email me" is a second button beside "Get a quote", styled one step quieter, opening a `mailto:` to koda@horizons.gg (built on
click, see above), with no preset subject since it serves job offers and general enquiries alike. LinkedIn stays in the "Find me on" panel.

The contact section at the end of the page gets the same pair of buttons, and its line changes from "Have a project in
mind or just want to say hi?" to one that covers both a project and a role.

## Project pages

Route: `/projects/[slug]`, statically generated for each project (`generateStaticParams`), each with its own
metadata (title, description, canonical, share image from the first screenshot), and all of them added to
`app/sitemap.ts`.

These pages sit outside the `(landing)` route group, in a new group, so they do not load the parallax scene: a plain
navy page in the same palette and type as the landing content (the frosted `Panel`, the `#0b101f` background), like the
existing `/blastyard` page.

Top to bottom:

1. "Back to projects" link to `/#projects`.
2. Logo, name, year (or year range), category, context label.
3. One-paragraph summary.
4. Links as buttons: live site, GitHub, store pages, Steam Workshop, download, whichever exist. A store without a
   link shows "Coming soon" as today.
5. Gallery: the first screenshot large; the rest as thumbnails in a grid on desktop and a sideways, snap-scrolling row
   on a phone. Tapping one opens it full screen (the existing `ui/Dialog` is the starting point), with left and
   right to move and Escape to close. Desktop and mobile screenshots are both shown, mobile ones in a phone-shaped
   frame.
6. "What it does": two or three short paragraphs.
7. "Highlights": three to six bullets of the hard or notable parts, with the README's numbers where they exist.
8. "Built with": the tech as tags.
9. "How it was built": one line from the split above, for example "Written by hand" or "Built with Claude, designed
   and directed by me", and for ASOT "By hand from 2024, with Claude since late 2025". Only on the project page.
10. Next and previous project links, in the same order as the landing page.

Blastyard already has a page at `/blastyard` (its store and Epic Developer Portal site, with a privacy policy and
EULA). `/projects/blastyard` is still made like the others, and links to `/blastyard` as "Game website".

## Data

One typed module holds every project, used by both the landing page and the project pages, replacing the `projects`
array in `app/(landing)/page.tsx`. The shape, roughly:

```ts
type Category = 'website' | 'web-app' | 'desktop-app' | 'mobile-app' | 'game' | 'mod'
type Built = 'hand' | 'claude' | 'both'

interface Project {
    slug: string
    name: string
    years: string                      // '2026', or '2024 to 2026'
    category: Category
    context: 'client' | 'personal' | 'community'
    featured?: number                  // position among the featured, 1 to 4
    line: string                       // the one line used on cards and rows
    summary: string                    // the project page's opening paragraph
    body: string[]                     // "What it does" paragraphs
    highlights: string[]
    tech: string[]
    built: Built
    builtNote?: string                 // overrides the default "How it was built" line
    logo?: { src: string, background?: 'light' | 'dark' }
    screenshots: { src: string, alt: string, device: 'desktop' | 'mobile' }[]   // empty means placeholder
    links: { website?: string, github?: string, workshop?: string, download?: string, gameSite?: string,
             stores?: { name: string, href?: string }[] }
}
```

## Content: per project facts

Copy is drafted from the repositories (surveyed read-only on 2026-10-21). Facts the builder needs per project:

| Project | Category | Context | Years | Links | Logo | Screenshots |
|---|---|---|---|---|---|---|
| PMPC Group | Website | Client | 2025 to 2026 | pmpcgroup.horizons.gg (see Open questions) | real, `KL-Designs/PMPC-Group:public/logo/logo.svg` (and white variant) | Koda's folder, `PMPC Group/` (15, desktop and mobile) |
| Spot On Drones | Web app (public site, client livestream, staff dashboard) | Client | 2024 to 2026 | www.spotondrones.com | real, `KL-Designs/SpotOnDrones:public/designs/LogoFulld.png` and others | none in folder: capture the live site |
| Atomic Sandbox | Desktop app | Personal | 2026 | github.com/ItsKodas/atomic-sandbox | drawn in code (`crates/app/src/icon.rs`), no file: use a monogram tile | folder root, `01` to `05` (5); about 39 more in the repo's `docs/images/` |
| ASOT Milsim | Web app | Community | 2024 to 2026 | www.asotmilsim.com, github.com/KL-Designs/ASOT | real, `KL-Designs/ASOT:apps/web/public/ASOT-logo.png` | folder, `ASOT/` (25, including mobile) |
| Blastyard | Game | Personal | 2026 | Epic Games Store (existing link), Steam coming soon, `/blastyard` | real brand kit, `ItsKodas/blastyard:brand/exports/icon/` and `branding/logo.png` | from the repo: `Docs/screenshots/neon-district/`, `brand/exports/menus/after/`, `brand/exports/hud/after/` |
| Voxweave | Desktop app | Personal | 2026 | github.com/ItsKodas/voxweave, releases/latest | none (Tauri default icons): monogram | folder, `Voxweave/` (6) |
| The Back Room | Web app | Personal | 2026 | thebackroom.dev, github.com/ItsKodas/the-back-room | real, small: `apps/web/public/favicon.svg` | none: capture the live site |
| 1st CANZUK Brigade | Website (with staff admin) | Community | 2026 | 1stcanzukbrigade.com | the unit's crest, `public/logo.png` | none: capture the live site |
| AI Culler | Mod (Arma 3) | Personal | 2026 | Steam Workshop id 3744994173, github.com/ItsKodas/ai-culler | real, `icon.png` (1024 px) | none: placeholder |
| Tax Assistant | Mobile app (with API and web client) | Personal | 2023 to 2024 | GitHub only if the repo is public and clean (see Constraints) | real, `Mobile/assets/icon.png` | none: placeholder |
| Arby's Auto Glass | Website | Client (built: both) | 2022 to 2026 (original 2022, rebuild 2025 to 2026) | www.arbysauto.com | real, `KL-Designs/Arbys:public/logo.png` | folder, `arbys-auto-glass/` (18, desktop and mobile) |
| Horizons Portfolio | Website | Personal | 2019 to 2026 | github.com/ItsKodas/Portfolio | the site's own `app/(landing)/logo/logo.png` | capture this site |

The surveys found more detail (feature lists, test counts, README numbers) that the builder should pull from the
repositories with `gh api` when writing each page. Points to get right:

- Blastyard's GitHub description says Godot; `main` is Unreal Engine 5.8 and C++. The Godot prototype is on `legacy`.
  The Epic build reaches testers through the launcher; keep the store wording to what the existing site says.
- Voxweave's README says only synthetic audio has been trained so far: do not claim real-voice results.
- AI Culler is SQF and Arma config, not C++.
- ASOT is in the KL-Designs org; Koda made about 1,490 of its roughly 1,545 contributions.
- Spot On Drones and PMPC each have an unreleased redesign branch; describe what is live.
- Tax Assistant's `Server/test/IMG_007*.jpg` are photos of real receipts: never use them.

## Images

- Copy the chosen screenshots into `public/projects/<slug>/`, never editing Koda's originals. Convert to WebP, at most
  1600 px wide for desktop shots and 800 px for mobile shots (sharp is already a dependency), and crop very tall
  full-page captures to the part worth showing.
- Pick about six per project for the page and one as the cover (the first). Full-page captures over about 3x their
  width are left out or cropped.
- Logos go in the same folder as SVG where one exists, otherwise PNG at about 256 px.
- Use `next/image` with `sizes` set, lazy everywhere except the first image on a project page.
- **Placeholder:** a 16:9 panel in the page's navy with the project's logo (or monogram) centred and a faint grid, so it
  reads as deliberate. Swapping in a real screenshot is only a matter of adding files and listing them in the data.

## Constraints

- Tax Assistant's public repo contains a leaked Google service-account key; a separate session is cleaning it up
  (Torch.js-Server and Horizons-Universe are already private and archived). At build time, link Tax Assistant's GitHub
  only if the repo is public and the key is gone from it; otherwise show no GitHub link.
- Every external link must be checked to load before it ships.
- Never use an em dash in copy, code strings, docs or commit messages.
- Mobile first: test at 375 px wide as well as desktop.
- Respect `prefers-reduced-motion` in any new transitions.

## Testing

- A data test: slugs unique, every category has a label, featured positions 1 to 4 used once each, every listed
  screenshot and logo file exists, no em dash in any string, every link is https.
- Component tests: the tabs show only non-empty categories; "All" shows the featured block; a category hides it and
  includes featured projects of that kind; rows and cards link to `/projects/<slug>`.
- Project page tests: renders for every slug; a project without screenshots shows the placeholder; "How it was built"
  matches the data.
- Check in the browser at desktop and 375 px, and that the landing page's load is not noticeably heavier (thumbnails
  only, lazily loaded).

## Left to the builder

- Exact visual styling within the existing palette and components, the tab and row design details, the lightbox.
- Which six screenshots each project page uses, and the crops.
- Writing every project's copy from the repos, in the voice described above: plain, specific, and in the first person ("I built")
  throughout, including the project pages.
- Capturing the live sites for Spot On Drones, The Back Room, 1st CANZUK Brigade and this site with the browser,
  public pages only: never sign in to a production site. Screenshots of dashboards and signed-in views come from Koda
  later, and only with the client's blessing where it is a client's system (builder's call).

## Known issues outside this work

- `/blastyard` links "Download the latest build" to the releases of a private repo, which is a 404 for the public.
  The Blastyard project page does not link a download; fixing `/blastyard` is a separate change.
