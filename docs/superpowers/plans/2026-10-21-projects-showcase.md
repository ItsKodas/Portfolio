# Projects Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the landing page's flat project grid with four featured cards and a filterable list, give each of the 12 projects its own page with screenshots, and rewrite the About and contact sections so the page works as Koda's CV.

**Architecture:** One typed data module (`app/showcase/projects.ts`) feeds both the landing section (a client component with category tabs) and statically generated pages at `/projects/[slug]` in a new `(work)` route group that skips the parallax scene. Screenshots and logos are copied from Koda's folder and the repos into `public/projects/<slug>/` by a script that converts them to WebP.

**Tech Stack:** Next.js 15 App Router, React 18, TypeScript, Tailwind, next/image, sharp 0.34 (already installed through next), Vitest with jsdom and Testing Library, `gh` CLI, headless Microsoft Edge for captures.

**Spec:** `docs/superpowers/specs/2026-10-21-projects-showcase-design.md`

## Global Constraints

- Never use an em dash (U+2014) anywhere: copy, code strings, docs, commit messages. Comments in code may use them, but the data test bans them in project strings.
- Exactly these 12 projects: Blastyard, Atomic Sandbox, Voxweave, The Back Room, 1st CANZUK Brigade, ASOT Milsim, Tax Assistant, Arby's Auto Glass, Spot On Drones, PMPC Group, Horizons Portfolio, AI Culler.
- Featured, in order: PMPC Group, Spot On Drones, Atomic Sandbox, ASOT Milsim.
- Copy is plain, specific and first person ("I built"). Banned words: seamless, robust, leverage, cutting-edge, passionate, innovative, elevate, empower, state-of-the-art, delve, world-class. Numbers only as the repos' READMEs state them.
- Never edit or move Koda's originals in `C:\Users\koda\OneDrive\Desktop\screenshots`. New captures may be added there in a new subfolder per project (the folder's own CLAUDE.MD asks for that).
- Never sign in to a production site. Capture public pages only.
- Every external link is https and loads (status below 400) before it ships.
- The address koda@horizons.gg never appears in server-rendered HTML.
- Keep "Fullstack Developer" (About) and "Fullstack Development" (hero, `SITE.tagline`, `SITE.role`) unchanged.
- Works at 375 px wide with no horizontal scroll; new motion respects `prefers-reduced-motion`.
- Palette: background `#0b101f`, panel `#111a38`, accents `#8fd4f5` (lake), `#b597cc` (lilac), `#f19bb3` / `#f7c5d3` (pink), body text `#b4c3dc`, muted `#8fa3c7`.

## Review Focus

1. Arriving at `/#projects` from a project page's back link: the page must land on the projects section and still scroll back up. The browser's own anchor scroll moves the parallax wrapper (`overflow-hidden`) and strands the page, the same bug the hero button had. Pinned in Task 4 (wrapper becomes `overflow-clip`, and a hash on load glides to the section).
2. Keyboard focus moving onto a project row far down the page scrolls the same wrapper for the same reason. Fixed by the same `overflow-clip` change; checked by tabbing in Task 8.
3. A project with neither screenshots nor a logo-less fallback breaking a card: the placeholder must render with a monogram. Pinned in Task 3.
4. An unknown slug such as `/projects/nope` must 404, not render an empty page. Pinned in Task 5.
5. Long names and lines at 375 px (for example "1st CANZUK Brigade", and every one-line summary) must truncate, not widen the page. Checked in Task 8 with `scrollWidth`.

---

## Before Task 1

The branch already has uncommitted, tested hero changes that ship with this work (the "My Projects" button and its
`scrollToContent` glide, the `Code` icon, the "Need something built?" note). Commit them first so each task's commit
holds only its own work:

```bash
git add "app/(landing)/logo/index.tsx" "app/(landing)/page.tsx" "app/(landing)/parallax/index.tsx" "app/(landing)/parallax/content.ts" "app/(landing)/scroll" ui/icons
git commit -m "Point the hero at my projects and widen the note to more than websites"
```

---

## File Structure

- `app/showcase/projects.ts`: types, labels, the 12 projects, and pure helpers. No React.
- `app/showcase/projects.test.ts`: data invariants and helper behaviour (unit project).
- `app/showcase/Panel.tsx`: the frosted panel, moved out of `app/(landing)/page.tsx` so project pages share it.
- `app/showcase/ProjectLogo.tsx`, `app/showcase/Cover.tsx`: logo tile (or monogram) and cover image (or placeholder). Tests beside them.
- `app/(landing)/projects/ProjectsSection.tsx`, `FeaturedCard.tsx`, `ProjectRow.tsx`: the landing section. Test beside it.
- `app/(landing)/EmailLink.tsx`: the "Email me" button. Test beside it.
- `app/(work)/projects/[slug]/page.tsx`, `Gallery.tsx`: the project page and its lightbox. Tests beside them.
- `scripts/project-images.mjs`, `scripts/project-images.json`: the image pipeline and its job list.
- `public/projects/<slug>/`: generated images (committed).
- Modify: `app/(landing)/page.tsx`, `app/(landing)/parallax/index.tsx`, `app/(landing)/parallax/content.ts`, `app/site.ts`, `app/layout.tsx`, `app/sitemap.ts`.

---

### Task 1: The project data module

**Files:**
- Create: `app/showcase/projects.ts`
- Test: `app/showcase/projects.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Category = 'website' | 'web-app' | 'desktop-app' | 'mobile-app' | 'game' | 'mod'
  export const CATEGORIES: { id: Category, label: string }[]   // tab order and labels:
  //   website 'Websites', web-app 'Web apps', desktop-app 'Desktop apps', mobile-app 'Mobile apps', game 'Games', mod 'Mods'
  export const CATEGORY_NAME: Record<Category, string>          // singular: 'Website', 'Web app', 'Desktop app', 'Mobile app', 'Game', 'Mod'
  export type Context = 'client' | 'personal' | 'community'
  export const CONTEXT_LABEL: Record<Context, string>           // 'Client project', 'Personal project', 'Community project'
  export type Built = 'hand' | 'claude' | 'both'
  export interface Shot { src: string, alt: string, device: 'desktop' | 'mobile' }
  export interface Project {
      slug: string; name: string; years: [number, number]; category: Category; context: Context
      featured?: 1 | 2 | 3 | 4; line: string; summary: string; body: string[]; highlights: string[]; tech: string[]
      built: Built; builtNote?: string
      logo?: { src: string, background: 'light' | 'dark' }
      screenshots: Shot[]
      links: { website?: string, websiteLabel?: string, github?: string, workshop?: string, download?: string,
               gameSite?: string, stores?: { name: 'Epic Games Store' | 'Steam', href?: string }[] }
  }
  export const PROJECTS: Project[]
  export function getProject(slug: string): Project | undefined
  export function featured(): Project[]                 // by featured position
  export function listed(): Project[]                   // non-featured, sorted
  export function inCategory(c: Category): Project[]    // all of that category, featured included, sorted
  export function categoriesInUse(): Category[]         // CATEGORIES order, only non-empty
  export function neighbours(slug: string): { previous?: Project, next?: Project }  // order: featured() then listed()
  export function yearsLabel(p: Project): string        // '2026' or '2024 to 2026'
  export function builtLine(p: Project): string
  export function monogram(name: string): string
  ```
- Sorting for `listed` and `inCategory`: `years[1]` descending, then `years[0]` descending, then `name` ascending.

- [ ] **Step 1: Write the failing tests** in `app/showcase/projects.test.ts`:

```ts
it('has exactly the 12 projects', () => {
    expect(PROJECTS.map(p => p.name).sort()).toEqual(["AI Culler", "ASOT Milsim", "Arby's Auto Glass", 'Atomic Sandbox', 'Blastyard',
        'Horizons Portfolio', 'PMPC Group', 'Spot On Drones', 'Tax Assistant', 'The Back Room', 'Voxweave', '1st CANZUK Brigade'].sort())
})
it('features PMPC, Spot On Drones, Atomic Sandbox and ASOT in that order', () => {
    expect(featured().map(p => p.slug)).toEqual(['pmpc-group', 'spot-on-drones', 'atomic-sandbox', 'asot-milsim'])
})
it('has unique slugs of lowercase words joined by hyphens', ...)          // /^[a-z0-9]+(-[a-z0-9]+)*$/
it('lists the rest newest first without the featured', () => {
    expect(listed()).toHaveLength(8)
    expect(listed().some(p => p.featured)).toBe(false)
    // years[1] never increases down the list
})
it('includes featured projects in a category view', () => {
    expect(inCategory('desktop-app').map(p => p.slug)).toEqual(expect.arrayContaining(['atomic-sandbox', 'voxweave']))
})
it('only offers categories that have a project', () => {
    expect(categoriesInUse()).toEqual(['website', 'web-app', 'desktop-app', 'mobile-app', 'game', 'mod'])
})
it('says how each project was built', () => {
    expect(builtLine(getProject('tax-assistant')!)).toBe('Written by hand')
    expect(builtLine(getProject('voxweave')!)).toBe('Built with Claude, designed and directed by me')
    expect(builtLine(getProject('asot-milsim')!)).toBe('By hand from 2024, with Claude since late 2025')
})
it('gives every "both" project its own note', ...)                          // built === 'both' implies builtNote
it('labels years', () => {
    expect(yearsLabel(getProject('voxweave')!)).toBe('2026')
    expect(yearsLabel(getProject('asot-milsim')!)).toBe('2024 to 2026')
})
it('makes monograms', () => {
    expect(monogram('Atomic Sandbox')).toBe('AS'); expect(monogram('Voxweave')).toBe('V'); expect(monogram('1st CANZUK Brigade')).toBe('1C')
})
it('wraps around for neighbours', () => {
    expect(neighbours('pmpc-group').previous?.slug).toBe(listed().at(-1)!.slug)
    expect(neighbours('pmpc-group').next?.slug).toBe('spot-on-drones')
})
it('only links over https', ...)                                            // every links.* string and store href starts with 'https://'
it('uses no em dash and no banned word in any string', ...)                 // walk every string in PROJECTS; banned list from Global Constraints, case-insensitive whole word
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run app/showcase/projects.test.ts`
Expected: FAIL, cannot find module `./projects`.

- [ ] **Step 3: Implement `app/showcase/projects.ts`**

Fill every project's metadata from the spec's per-project table: slug, name, years, category, context, featured, tech (from the spec and the old `projects` array in `app/(landing)/page.tsx`), built and builtNote, links. Values the spec pins:
- Built: `hand` for Tax Assistant, Spot On Drones, PMPC Group; `both` for Arby's Auto Glass (builtNote `'By hand from 2022, with the 2026 redesign built with Claude'`), ASOT Milsim (`'By hand from 2024, with Claude since late 2025'`), Horizons Portfolio (`'About half by hand and half with Claude'`); `claude` for the other six.
- Years: Blastyard, Atomic Sandbox, Voxweave, The Back Room, 1st CANZUK, AI Culler `[2026, 2026]`; ASOT `[2024, 2026]`; Spot On Drones `[2024, 2026]`; PMPC `[2025, 2026]`; Arby's `[2022, 2026]`; Tax Assistant `[2023, 2024]`; Horizons Portfolio `[2019, 2026]`.
- Categories: website for PMPC, Arby's, 1st CANZUK, Horizons Portfolio; web-app for Spot On Drones, ASOT, The Back Room; desktop-app for Atomic Sandbox, Voxweave; mobile-app for Tax Assistant; game for Blastyard; mod for AI Culler.
- PMPC: `website: 'https://pmpcgroup.horizons.gg/'`, `websiteLabel: 'View my build'`.
- Blastyard: stores `[{ name: 'Epic Games Store', href: 'https://store.epicgames.com/p/blastyard-b6300d' }, { name: 'Steam' }]`, `gameSite: '/blastyard'` (internal, exempt from the https rule), no download.
- AI Culler: `workshop: 'https://steamcommunity.com/sharedfiles/filedetails/?id=3744994173'`, `github: 'https://github.com/ItsKodas/ai-culler'`.
- Voxweave: `download: 'https://github.com/ItsKodas/voxweave/releases/latest'`.
- Tax Assistant: no `github` yet (Task 6 decides).
- `line`: reuse the old blurbs, cut to one sentence of at most 90 characters. `summary`: the old blurb. `body` and `highlights`: one placeholder sentence each for now, replaced in Task 6 (the tests above must still pass). `screenshots: []` and no `logo` for now; Task 2 fills them.

`builtLine`: `hand` gives `'Written by hand'`, `claude` gives `'Built with Claude, designed and directed by me'`, `both` gives `builtNote`. `monogram`: first character of the first two words, uppercased.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run app/showcase/projects.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/showcase/projects.ts app/showcase/projects.test.ts
git commit -m "Add the project data module for the showcase"
```

---

### Task 2: Screenshots and logos

**Files:**
- Create: `scripts/project-images.mjs`, `scripts/project-images.json`, `public/projects/<slug>/*`
- Modify: `app/showcase/projects.ts` (screenshots and logo per project)
- Test: `app/showcase/projects.test.ts`

**Interfaces:**
- Consumes: `Project.screenshots`, `Project.logo` from Task 1.
- Produces: files under `public/projects/<slug>/` named `01.webp`, `02.webp`, ... in display order, and `logo.svg` or `logo.png`. Data paths are `/projects/<slug>/01.webp`.

- [ ] **Step 1: Add the failing test** to `app/showcase/projects.test.ts`:

```ts
it('points only at image files that exist', () => {
    // for every screenshot src and logo src: existsSync(join('public', src)) is true
})
it('has a cover screenshot for every project except AI Culler and Tax Assistant', () => {
    // PROJECTS without a desktop screenshot, by slug, equal ['ai-culler', 'tax-assistant']
})
it('gives every project with a real logo its logo', () => {
    // every project except 'atomic-sandbox' and 'voxweave' has a logo
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/showcase/projects.test.ts`
Expected: FAIL on the cover and logo tests.

- [ ] **Step 3: Capture the missing sites into Koda's folder**

Headless Edge, public pages only, new subfolders only. For each of `spot-on-drones` (https://www.spotondrones.com/), `the-back-room` (https://thebackroom.dev/), `1st-canzuk-brigade` (https://1stcanzukbrigade.com/) and `horizons-portfolio` (http://localhost:3000/ with the dev server running), capture the home page at 1440x900 and 390x844, plus up to three more public pages linked from the home page:

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --hide-scrollbars --window-size=1440,900 --virtual-time-budget=8000 --screenshot="C:\Users\koda\OneDrive\Desktop\screenshots\<slug>\desktop-01-home.png" <url>
```

Look at each capture (Read it) and drop any that show a cookie banner, a blank loading state or an error.

Also download Blastyard's shots into `...\screenshots\blastyard\` with `gh api -H "Accept: application/vnd.github.raw" "repos/ItsKodas/blastyard/contents/<path>" > <file>` for: `Docs/screenshots/neon-district/overview.jpg`, `plaza.jpg`, `roofs.jpg`, `brand/exports/menus/after/1-main-menu.jpg`, `4-server-browser.jpg`, `brand/exports/hud/after/1-hud.jpg`.

- [ ] **Step 4: Write `scripts/project-images.mjs` and its job list**

`node scripts/project-images.mjs --from "C:\Users\koda\OneDrive\Desktop\screenshots"` reads `scripts/project-images.json`, an array of `{ slug: string, out: string, kind: 'desktop' | 'mobile' | 'logo', from?: string, gh?: string }` where `from` is a path relative to `--from` and `gh` is `owner/repo:path` fetched raw with `gh api`. It writes `public/projects/<slug>/<out>`:
- `desktop`: WebP, quality 80, resized to at most 1600 px wide; if the source is taller than 2x its width, crop to the top 1x width (16:10) first.
- `mobile`: the same at most 800 px wide, cropping anything taller than 2.4x its width to the top 2.2x.
- `logo`: SVG copied as is; PNG resized to at most 256 px on the long side, kept PNG.

It never writes outside `public/projects/`, overwrites its own outputs, and prints one line per file.

Job list choices (about six per project, the cover first and always desktop):
- PMPC Group from `PMPC Group/`: 01-home-hero-desktop, 03-home-cards-hover-desktop, 05-about-desktop, 07-solutions-desktop, 09-home-hero-mobile, 10-home-cards-mobile. Logo `gh: KL-Designs/PMPC-Group:public/logo/logoWhite.svg` (dark background).
- Spot On Drones: the Step 3 captures. Logo `gh: KL-Designs/SpotOnDrones:public/designs/LogoFulld.png`.
- Atomic Sandbox: the folder root `02-ethylene-orbitals.png` first, then `01`, `03`, `04`, `05`. No logo.
- ASOT Milsim from `ASOT/`: 01-home-hero, 03-orbat, 05-milpacs, 06b-milpac-profile, 07-gallery, 30-mobile-home, 31-mobile-orbat. Logo `gh: KL-Designs/ASOT:apps/web/public/ASOT-logo.png`.
- Blastyard: the Step 3 downloads, `overview.jpg` first. Logo `gh: ItsKodas/blastyard:brand/exports/icon/blastyard-icon.svg`.
- Voxweave from `Voxweave/`: all six, 01 first. No logo.
- The Back Room and 1st CANZUK Brigade: the Step 3 captures. Logos `gh: ItsKodas/the-back-room:apps/web/public/favicon.svg` and `gh: ItsKodas/1st-canzuk-brigade:public/logo.png`.
- Arby's Auto Glass from `arbys-auto-glass/`: desktop-01-hero, desktop-02-services, desktop-03-service-area, desktop-07-quote, mobile-01-hero, mobile-06-quote. Logo `gh: KL-Designs/Arbys:public/logo.png`.
- Horizons Portfolio: the Step 3 captures. Logo copied from `app/(landing)/logo/logo.png` (use `from` with an absolute path; allow absolute `from`).
- AI Culler: logo `gh: ItsKodas/ai-culler:icon.png`. Tax Assistant: logo `gh: ItsKodas/Tax-Assistant:Mobile/assets/icon.png`. No screenshots for either. Never touch `Server/test/IMG_007*.jpg`.

- [ ] **Step 5: Run it, then fill the data**

Run: `node scripts/project-images.mjs --from "C:\Users\koda\OneDrive\Desktop\screenshots"`
Expected: one line per file, no errors. Then set each project's `screenshots` (with a specific `alt` per shot that says what it shows, for example `'The ORBAT page listing each section and its members'`) and `logo` (`background: 'light'` for logos drawn for white backgrounds: Spot On Drones, Arby's; `'dark'` otherwise).

- [ ] **Step 6: Run the tests**

Run: `npx vitest run app/showcase/projects.test.ts`
Expected: PASS. Also run `du -sh public/projects` and expect under 15 MB.

- [ ] **Step 7: Commit**

```bash
git add scripts/project-images.mjs scripts/project-images.json public/projects app/showcase/projects.ts app/showcase/projects.test.ts
git commit -m "Add project screenshots and logos"
```

---

### Task 3: Shared panel, logo tile and cover

**Files:**
- Create: `app/showcase/Panel.tsx`, `app/showcase/ProjectLogo.tsx`, `app/showcase/Cover.tsx`
- Modify: `app/(landing)/page.tsx` (import `Panel` from the new file, delete the local one)
- Test: `app/showcase/Cover.test.tsx`, `app/showcase/ProjectLogo.test.tsx`

**Interfaces:**
- Consumes: `Project`, `monogram` from Task 1.
- Produces:
  ```ts
  export function Panel({ children, className }: { children: React.ReactNode, className?: string }): JSX.Element  // same markup as today's
  export function ProjectLogo({ project, size }: { project: Project, size: number }): JSX.Element
  // a rounded square of `size` px: the logo on white (background 'light') or on #111a38 (background 'dark'),
  // or the monogram in white bold on #1a2550 when there is no logo. alt is `${project.name} logo`; the monogram is aria-hidden.
  export function Cover({ project, sizes, priority }: { project: Project, sizes: string, priority?: boolean }): JSX.Element
  // fills its parent (the parent sets the aspect ratio and `relative`): the first desktop screenshot with next/image
  // `fill`, object-cover, object-top; or, with none, a placeholder: navy panel, faint 24 px grid, ProjectLogo size 56
  // centred, and the label "Screenshots coming soon" in muted text. The placeholder has data-testid="cover-placeholder".
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the first desktop screenshot as the cover', () => {
    render(<div className="relative"><Cover project={getProject('atomic-sandbox')!} sizes="50vw" /></div>)
    expect(screen.getByRole('img')).toHaveAttribute('alt', getProject('atomic-sandbox')!.screenshots[0].alt)
})
it('shows a placeholder with the logo when there are no screenshots', () => {
    render(<div className="relative"><Cover project={getProject('ai-culler')!} sizes="50vw" /></div>)
    expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'AI Culler logo' })).toBeInTheDocument()
    expect(screen.getByText('Screenshots coming soon')).toBeInTheDocument()
})
it('falls back to a monogram without a logo', () => {
    render(<ProjectLogo project={{ ...getProject('voxweave')!, logo: undefined }} size={40} />)
    expect(screen.getByText('V')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run app/showcase`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the three components** as specified above. `Panel` is moved verbatim from `app/(landing)/page.tsx`.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run app/showcase && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/showcase "app/(landing)/page.tsx"
git commit -m "Add the shared panel, project logo and cover"
```

---

### Task 4: The landing projects section

**Files:**
- Create: `app/(landing)/projects/ProjectsSection.tsx`, `FeaturedCard.tsx`, `ProjectRow.tsx`
- Modify: `app/(landing)/page.tsx` (heading, intro, render `<ProjectsSection />`, delete the old `projects` array, `Store` type and grid), `app/(landing)/parallax/index.tsx` (wrapper `overflow-hidden` becomes `overflow-clip`), `app/(landing)/parallax/content.ts` (`scrollToContent` gains a `behavior: ScrollBehavior = 'smooth'` third parameter)
- Test: `app/(landing)/projects/ProjectsSection.test.tsx`

**Interfaces:**
- Consumes: `featured`, `listed`, `inCategory`, `categoriesInUse`, `CATEGORIES`, `CATEGORY_NAME`, `CONTEXT_LABEL`, `yearsLabel` (Task 1); `Panel`, `ProjectLogo`, `Cover` (Task 3); `scrollToContent(el, margin?, behavior?)`.
- Produces: `export default function ProjectsSection(): JSX.Element` ('use client').

Section copy (exact): eyebrow `Projects`, title `Built by me, start to finish`, intro `Everything here was designed, built and shipped by me: client websites, web apps, desktop apps, a game and mods.`

Behaviour: a `role="group"` with `aria-label="Filter projects"` of buttons, `All` first then `CATEGORIES` labels for `categoriesInUse()`, each with `aria-pressed`. `All`: the featured grid (`md:grid-cols-2`) then the rows of `listed()`. A category: no featured grid, rows of `inCategory(c)`. Featured card: `Link` to `/projects/<slug>` wrapping a 16:9 cover (16:10 below `sm`), logo overlapping the cover's bottom-left, name and years, `CATEGORY_NAME · CONTEXT_LABEL`, the `line`, up to four `tech` tags, and "Read more". Row: `Link` to `/projects/<slug>` with a 64 px wide 16:10 cover, a 32 px logo, name, `CATEGORY_NAME · years`, the `line` on one truncated line (`truncate` with `min-w-0` on its column), and a chevron (`ArrowForward`). Covers use `sizes` of `(min-width: 768px) 480px, 100vw` for cards and `64px` for rows.

On mount, if `location.hash === '#projects'`, wait (requestAnimationFrame loop, at most 2 s) until `document.documentElement.scrollHeight > window.innerHeight * 1.5`, then `scrollToContent(section, 48, 'auto')`.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the four featured cards and the other eight as rows by default', () => {
    render(<ProjectsSection />)
    expect(screen.getAllByTestId('featured-card')).toHaveLength(4)
    expect(screen.getAllByTestId('project-row')).toHaveLength(8)
})
it('offers only categories with a project, All first', () => {
    render(<ProjectsSection />)
    const group = screen.getByRole('group', { name: 'Filter projects' })
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(['All', 'Websites', 'Web apps', 'Desktop apps', 'Mobile apps', 'Games', 'Mods'])
})
it('hides the featured block in a category and lists featured projects of that kind', async () => {
    render(<ProjectsSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Desktop apps' }))
    expect(screen.queryAllByTestId('featured-card')).toHaveLength(0)
    expect(screen.getAllByTestId('project-row').map(r => r.getAttribute('href'))).toEqual(['/projects/atomic-sandbox', '/projects/voxweave'])
    expect(screen.getByRole('button', { name: 'Desktop apps' })).toHaveAttribute('aria-pressed', 'true')
})
it('links every card and row to its project page', ...)   // featured-card hrefs equal featured().map(p => `/projects/${p.slug}`)
it('glides to the section when the page opens on #projects', ...)
// vi.mock('../parallax/content') and assert scrollToContent was called with the section element, 48 and 'auto'
// after setting location.hash = '#projects' and making scrollHeight large (Object.defineProperty on documentElement)
```

(`next/link` renders a plain anchor in jsdom; put `data-testid` on the anchor.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run "app/(landing)/projects"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the three components, wire them into `page.tsx`, change the wrapper to `overflow-clip` and add the `behavior` parameter**

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run "app/(landing)" app/showcase && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Check it in the browser**

With the dev server running, at 1440x900 and at 375x812: the section shows the four cards and the rows; tabs filter; the hero's My Projects button still glides to the section and the wheel scrolls back to the top; `window.scrollY` changes and the wrapper's `scrollTop` stays 0. Screenshot both widths.

- [ ] **Step 6: Commit**

```bash
git add "app/(landing)"
git commit -m "Show featured projects and a filterable list on the home page"
```

---

### Task 5: Project pages

**Files:**
- Create: `app/(work)/projects/[slug]/page.tsx`, `app/(work)/projects/[slug]/Gallery.tsx`
- Modify: `app/sitemap.ts`
- Test: `app/(work)/projects/[slug]/page.test.tsx`, `app/(work)/projects/[slug]/Gallery.test.tsx`, `app/sitemap.test.ts`

**Interfaces:**
- Consumes: everything in Task 1, and `Panel`, `ProjectLogo`, `Cover` from Task 3.
- Produces:
  ```ts
  export const dynamicParams = false
  export function generateStaticParams(): { slug: string }[]
  export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata>
  // title: project.name; description: project.summary; alternates.canonical: `/projects/${slug}`;
  // openGraph.images: [first screenshot src] when there is one
  export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }): Promise<JSX.Element>
  // calls notFound() for an unknown slug
  export function Gallery({ shots, name }: { shots: Shot[], name: string }): JSX.Element   // 'use client'
  ```

Page, top to bottom, on `bg-[#0b101f]` with `max-w-4xl` (follow `app/(blastyard)/blastyard/page.tsx` for the shell): a back link `Back to projects` to `/#projects`; `ProjectLogo` (64), `h1` name, `yearsLabel · CATEGORY_NAME · CONTEXT_LABEL`; the summary; link buttons in this order when present: website (label `websiteLabel ?? 'Visit site'`), GitHub, stores (a store without `href` shows "Coming soon" as the old landing card did), Steam Workshop, Download, `gameSite` as "Game website"; the `Gallery` (or a 16:9 `Cover` placeholder when there are no screenshots); `h2` "What it does" with `body` paragraphs; `h2` "Highlights" with a list; `h2` "Built with" with `tech` tags; `h2` "How it was built" with `builtLine`; previous and next links from `neighbours` labelled with the projects' names.

Gallery: the first shot large (16:10, `priority`), the rest as buttons with thumbnails, a grid of three on `md` and a snap-scrolling row below it. Mobile shots sit in a rounded phone-shaped frame (9:19.5) instead of 16:10. Clicking any shot opens the `ui/Dialog` with title `${name} screenshot ${i + 1} of ${n}` showing that shot with `object-contain`, Previous and Next buttons in its footer, and ArrowLeft / ArrowRight on the dialog moving with wraparound.

- [ ] **Step 1: Write the failing tests**

```ts
// page.test.tsx (vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND') } })))
it('renders a page for every project', async () => {
    for (const { slug } of generateStaticParams()) {
        render(await ProjectPage({ params: Promise.resolve({ slug }) }))
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(getProject(slug)!.name)
        cleanup()
    }
})
it('404s an unknown slug', async () => {
    await expect(ProjectPage({ params: Promise.resolve({ slug: 'nope' }) })).rejects.toThrow('NEXT_NOT_FOUND')
})
it('says how it was built', async () => {
    render(await ProjectPage({ params: Promise.resolve({ slug: 'asot-milsim' }) }))
    expect(screen.getByText('By hand from 2024, with Claude since late 2025')).toBeInTheDocument()
})
it('shows the placeholder for a project without screenshots', ...)   // ai-culler: getByTestId('cover-placeholder')
it('labels PMPC as my build', ...)                                    // getByRole('link', { name: /View my build/ }) has href https://pmpcgroup.horizons.gg/
it('links back to the projects section', ...)                         // getByRole('link', { name: /Back to projects/ }) has href '/#projects'
it('sets the canonical and description', async () => {
    const m = await generateMetadata({ params: Promise.resolve({ slug: 'voxweave' }) })
    expect(m.alternates?.canonical).toBe('/projects/voxweave')
    expect(m.description).toBe(getProject('voxweave')!.summary)
})

// Gallery.test.tsx
it('opens a shot in the lightbox and moves with the arrow keys, wrapping', async () => {
    const shots = getProject('voxweave')!.screenshots   // six
    render(<Gallery shots={shots} name="Voxweave" />)
    await userEvent.click(screen.getByRole('button', { name: shots[1].alt }))
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Voxweave screenshot 2 of 6')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Voxweave screenshot 6 of 6')
})

// app/sitemap.test.ts
it('lists every project page', () => {
    const urls = sitemap().map(e => e.url)
    for (const p of PROJECTS) expect(urls).toContain(`${SITE.url}/projects/${p.slug}`)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run "app/(work)" app/sitemap.test.ts`
Expected: FAIL, modules not found and the sitemap lacks project URLs.

- [ ] **Step 3: Implement the page, the gallery and the sitemap entries** (`changeFrequency: 'monthly'`, `priority: 0.7`).

- [ ] **Step 4: Run the tests, the type check and a build**

Run: `npx vitest run "app/(work)" app/sitemap.test.ts app/showcase && npx tsc --noEmit -p . && npm run build`
Expected: PASS, and the build output lists the 12 `/projects/...` pages as static.

- [ ] **Step 5: Commit**

```bash
git add "app/(work)" app/sitemap.ts app/sitemap.test.ts
git commit -m "Give every project its own page with a screenshot gallery"
```

---

### Task 6: Project copy

**Files:**
- Modify: `app/showcase/projects.ts`
- Test: `app/showcase/projects.test.ts`

**Interfaces:**
- Consumes: the `Project` fields from Task 1.

- [ ] **Step 1: Tighten the copy tests** in `app/showcase/projects.test.ts`:

```ts
it('gives every project a full write-up', () => {
    for (const p of PROJECTS) {
        expect(p.line.length).toBeLessThanOrEqual(90)
        expect(p.body.length).toBeGreaterThanOrEqual(2)
        expect(p.highlights.length).toBeGreaterThanOrEqual(3)
        expect(p.highlights.length).toBeLessThanOrEqual(6)
    }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/showcase/projects.test.ts`
Expected: FAIL (the placeholders from Task 1 have one body paragraph and one highlight).

- [ ] **Step 3: Write each project's `summary`, `body` and `highlights` from its repository**

Read each repo's README and docs with `gh api` (repos: ItsKodas/{atomic-sandbox, voxweave, blastyard, the-back-room, 1st-canzuk-brigade, ai-culler, Tax-Assistant, AAG, Portfolio}, KL-Designs/{ASOT, SpotOnDrones, PMPC-Group, Arbys}). First person, plain, specific; what it does for its users first, then what was hard. Quote numbers exactly as the README states them. Facts to get right (from the spec): Blastyard is Unreal Engine 5.8 and C++ (the Godot prototype is only on `legacy`) and reaches testers through the Epic launcher; Voxweave has only been trained on synthetic test audio; AI Culler is SQF and Arma config; Koda made about 1,490 of ASOT's roughly 1,545 contributions; Spot On Drones and PMPC describe what is live, not their redesign branches; PMPC's own domain no longer runs Koda's build.

Tax Assistant's GitHub link: run `gh api repos/ItsKodas/Tax-Assistant --jq .private` and `gh api "repos/ItsKodas/Tax-Assistant/commits?path=Mobile/google-api.json" --jq length`. Add `github: 'https://github.com/ItsKodas/Tax-Assistant'` only if the first prints `false` and the second prints `0`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run app/showcase/projects.test.ts`
Expected: PASS (including the em dash and banned word test).

- [ ] **Step 5: Commit**

```bash
git add app/showcase/projects.ts app/showcase/projects.test.ts
git commit -m "Write up every project from its repository"
```

---

### Task 7: About, contact and the Email me button

**Files:**
- Create: `app/(landing)/EmailLink.tsx`
- Modify: `app/(landing)/page.tsx`, `app/site.ts`, `app/layout.tsx`
- Test: `app/(landing)/EmailLink.test.tsx`

**Interfaces:**
- Produces: `export default function EmailLink({ className }: { className?: string }): JSX.Element` ('use client'): a `button` labelled `Email me` that calls `window.location.assign('mailto:koda@horizons.gg')`, the address assembled at click time from character codes so the literal string is in neither the HTML nor the bundle.

Copy (exact):
- About paragraph 1: `I'm a full-stack developer: I've spent years building websites and web apps for clients, from the database to the front end, written by hand. With AI tools in the mix I now build well past the web too: desktop apps, a game and mods. I use Claude as part of how I work. I decide what gets built and how it fits together, and I review and test everything that ships.`
- About paragraph 2: `I'm open to full-time roles as well as contract work.`
- About buttons: `QuoteLink` then `EmailLink`, the latter styled one step quieter (the lilac outline the GitHub chip uses).
- Contact line: `Have a project in mind, or a role you think I'd suit? Get in touch.` Buttons: `QuoteLink` and `EmailLink` side by side, then the socials as today.
- `SITE.description`: `I'm Koda, a full-stack developer. I build websites and web apps with Next.js, React, TypeScript and Node.js, and also desktop apps, games and mods.`
- `app/layout.tsx` keywords: keep the existing ones and add `"software developer"`, `"desktop app development"`, `"game development"`.
- The "Worked with" strip: PMPC's `href` becomes `https://pmpcgroup.horizons.gg/`.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps the address out of the markup', () => {
    const html = renderToStaticMarkup(<EmailLink />)
    expect(html).not.toMatch(/koda|horizons\.gg|mailto/i)
})
it('opens a mail to Koda when clicked', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    render(<EmailLink />)
    await userEvent.click(screen.getByRole('button', { name: 'Email me' }))
    expect(assign).toHaveBeenCalledWith('mailto:koda@horizons.gg')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run "app/(landing)/EmailLink.test.tsx"`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `EmailLink` and make the copy changes above**

- [ ] **Step 4: Run the tests, the type check, and a source check**

Run: `npx vitest run "app/(landing)" && npx tsc --noEmit -p . && grep -rn "koda@horizons.gg" app/ --include=*.tsx`
Expected: PASS, no type errors, and grep finds the address only in `EmailLink.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add "app/(landing)" app/site.ts app/layout.tsx
git commit -m "Say I'm open to work and add an Email me button"
```

---

### Task 8: Whole-site verification

**Files:** none new, fixes only.

- [ ] **Step 1: Full checks**

Run: `npm test && npx tsc --noEmit -p . && npm run lint && npm run build`
Expected: all pass. (`npm test` includes the db project, which needs `npm run services`; if Docker is not running, run `npx vitest run --project unit --project dom` and say the db project was skipped.)

- [ ] **Step 2: External links**

Collect every external URL from `PROJECTS` and the page, then run `curl -sL -o /dev/null -w "%{http_code} %{url_effective}\n" --max-time 20 -A "Mozilla/5.0" <url>` for each.
Expected: every status below 400. Fix or remove any that fail and say which.

- [ ] **Step 3: Browser checks at 1440x900 and 375x812**

On `/`: the featured cards and rows render with real images; tab through the page with the keyboard to a row near the bottom and confirm the parallax wrapper's `scrollTop` is still 0 and the page scrolls back up; `document.documentElement.scrollWidth <= window.innerWidth` at 375. Open three project pages (one with a placeholder, one with mobile shots, PMPC), use the lightbox with the keyboard, follow "Back to projects" and confirm it lands on the section and scrolls back up. Check the console for errors. Screenshot the home section and one project page at both widths.

- [ ] **Step 4: Em dash scan of the diff**

Run: `git diff Master --name-only | python -c "import sys; [print(f) for f in map(str.strip, sys.stdin) if f and '\u2014' in open(f, encoding='utf-8', errors='ignore').read()]"`
Expected: no file listed except code files where the dash is only inside comments (check each by eye).

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "Fix issues found verifying the projects showcase"
```
