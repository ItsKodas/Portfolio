# Staged scene tiers for the home page hero

Date: 2026-09-18

## Problem

Mobile browsers crash on the home page. The tab is killed and reloaded, and the browser
reports that it cannot open the page. The scene never gets the chance to fall back to its
lite version.

### Root cause

`app/perf/script.ts` picks the lite scene only when the browser is drawing without a GPU: it
asks for a WebGL context with `failIfMajorPerformanceCaveat` and checks the renderer string
for software rasterisers. A phone has a real GPU, so it passes that test and is marked
`data-perf="full"`. The server also always renders `FullScene`, because `useLite()` returns
`false` from its server snapshot.

The result is that a phone parses, styles, lays out and composites the entire full scene at
first paint. Measured in the browser at a 375x812 viewport:

| | full | lite |
| --- | --- | --- |
| elements with an animated transform/opacity or `will-change` | 252 | 39 |
| composited layers intersecting the viewport | 85 | 35 |
| overdraw | 20.93 viewports | 3.8 viewports |
| raster memory at DPR 3 | about 220 MB | about 39 MB |

220 MB of compositor raster is past the point where mobile Safari and Chrome kill the
renderer process. This is a memory ceiling, not a framerate ceiling, which matters because
the only existing fallback watches frame rate.

The fallback in `watchFrameRate` (`app/perf/usePerf.ts`) cannot run until the loading curtain
lifts (up to 5000 ms), then the `load` event fires, then a 1000 ms settle passes, then 60
frames are sampled. At 10 fps those 60 frames alone take 6 seconds. The earliest realistic
switch is 7 to 12 seconds after navigation. The tab dies during the first composite, long
before any of that.

A secondary contributor: `.layer` in `app/(landing)/parallax/parallax.module.css` carries
`will-change: transform` unconditionally. Even with `data-perf="lite"` set by the head script,
the pre-hydration window still costs 21 layers, 11.7 viewports of overdraw and about 122 MB,
because only the hydrated `LiteScene` swaps those elements for `.still`.

## Approach

Replace the binary full/lite switch with four cumulative scene tiers. A device is given a
budget before first paint, climbs to the highest tier that fits, and frame timing acts as a
second gate that can stop the climb short.

Three approaches were considered.

**Chosen: CSS attribute tiers with one React swap for depth.** The head script computes the
budget and writes tier tokens onto `<html>` before the body is parsed. Each scene stylesheet
keys its animations off a token. The one thing CSS cannot express, ten parallax depths versus
three, stays a React swap. This is the only approach that acts inside the pre-hydration
window, which is the crash window.

**Rejected: pure React tiers.** A `useTier()` hook with each component rendering or omitting
its own animated parts is a cleaner single source of truth, but React cannot act before first
paint. The server HTML is composited before hydration, measured at about 122 MB even with
lite CSS active, so this reintroduces the crash it is meant to fix.

**Rejected: server-side tier from Client Hints or user agent.** Produces the smallest HTML,
but forces the home page to dynamic rendering, relies on unreliable user agent sniffing, and
has no hints available on a first visit.

## The tier scale

Four cumulative tokens in a space separated `data-scene` attribute on `<html>`, following the
`data-still~="stars"` idiom already used by `app/(landing)/stars/stars.module.css` and the
wallpaper.

| tier | token | what it adds | overdraw | layers |
| --- | --- | --- | --- | --- |
| 0 | (none) | the current `LiteScene`: three depths, no scene animation | 3.8 | 35 |
| 1 | `depth` | the ten layer parallax | +7.0 | +7 |
| 2 | `sky` | star twinkle, drift, shooting stars, cloud drift | +10.0 | +26 |
| 3 | `water` | ripples, streaks, fog, boat bob, lantern flicker | +0.9 | +21 |
| 4 | `forest` | tree sway, gusts, wind streaks, leaves, fireflies, campfire | +0.2 | +162 |

Tokens are cumulative and always applied in this order. `data-scene="depth sky"` means tiers
0 through 2.

## The cost model

Cost is expressed as viewports of overdraw, which measurement shows is very nearly
viewport independent:

| part | at 375x812 | at 1024x768 |
| --- | --- | --- |
| parallax depth | 10.00 | 9.88 |
| stars | 8.43 | 8.43 |
| clouds | 1.56 | 1.76 |
| water | 0.88 | 0.52 |

This property is what makes the model usable, because the head script runs before layout and
can never measure real geometry. It can only multiply baked in constants by `innerWidth`,
`innerHeight` and `devicePixelRatio`, all available pre-paint.

Area alone is not enough. Tier 4 adds 162 layers for almost no area, and every composited
layer costs a minimum tile of backing store however small it is. So the model has two terms:

```
bytes(tier) = overdraw x vw x vh x dpr^2 x 4  +  layerCount x TILE_MIN
```

`TILE_MIN` is one 256x256 device pixel tile, 262144 bytes.

At 375x812 and DPR 3, one viewport of overdraw is about 10.96 MB, giving these cumulative
figures:

| through tier | added | cumulative |
| --- | --- | --- |
| 0 base | about 50 MB | about 50 MB |
| 1 `depth` | about 78 MB | about 128 MB |
| 2 `sky` | about 116 MB | about 244 MB |
| 3 `water` | about 15 MB | about 259 MB |
| 4 `forest` | about 43 MB | about 302 MB |

## The budget

```
budget    = allowance x memFactor
allowance = coarsePointer ? max(120 MB, viewportBytes x 14) : 1024 MB
memFactor = navigator.deviceMemory ? clamp(deviceMemory / 4, 0.5, 1.5) : 1
```

A touch device gets the larger of a 120 MB floor and an allowance that scales with its own
screen: 14 viewports of the same `vw x vh x dpr^2 x 4` term the cost model uses. The floor
exists so a small phone is not starved down to nothing; the area term exists so a large
screen is not held to the same ceiling as a small one.

### Why the shape changed

An earlier version of this budget was one fixed byte ceiling for every touch device,
`160 MB`, with `memMax` at `1.75`. That was wrong in a way that only shows up once you check
it against real device geometries rather than one synthetic viewport.

Safari reports no `navigator.deviceMemory` at all, on any iOS device. So every iPhone and
iPad shared that one fixed ceiling, while the scene's cost scales with viewport area times
`dpr^2`. Within Apple's own lineup, a bigger screen means a newer, more capable device, not a
weaker one. A fixed ceiling therefore penalised exactly the devices best able to cope: an
iPhone SE landed at the top tier while an iPad Pro, the strongest device in the sweep, landed
on the still scene with nothing. Sweeping the old constants found no combination that avoided
this: the iPad Pro reached tier 0 and the iPhone SE reached tier 3 or 4 in every one tried. It
was the shape of the model that was backwards, not its values, which is why this amendment
changes the formula rather than retuning the constants.

Separately, the old `memMax` of `1.75` let an 8GB Android device reach 274 MB, within 6% of
the roughly 292 MB configuration that was measured crashing. `memMax` now drops to `1.5`, so
that device's budget falls well clear of the crash boundary instead of grazing it.

Which lands as:

| device | signals | tier reached |
| --- | --- | --- |
| iPhone 15 | coarse, no `deviceMemory` | 1, `depth` |
| iPhone 15 Pro Max | coarse, no `deviceMemory` | 1, `depth` |
| iPad 10.9 | coarse, no `deviceMemory` | 1, `depth` |
| Pixel 8 | coarse, `deviceMemory` 8 | 1, `depth` |
| mid range Android | coarse, `deviceMemory` 4 | 1, `depth` |
| low end Android | coarse, `deviceMemory` 2 | 0, still scene |
| desktop Safari | fine, no `deviceMemory` | 4, all tiers |
| desktop Chrome | fine, `deviceMemory` 8 | 4, all tiers |

These are starting values. They are chosen so that no touch device reaches the state that
currently crashes, and so that every pointer driven device clears all four tiers and behaves
exactly as the site does today. They will need tuning against real hardware, which is why
they live in one file with their reasoning in comments.

Note that `sky` is expensive enough (8.43 viewports on its own) that most phones will settle
at `depth`. See Future work.

### Residual: the iPhone SE still reaches a higher tier than other phones

One quirk survives this change and is left as-is. On a 375x667, DPR 2 screen, the per-layer
tile minimums dominate the cost while the area term is tiny, so the whole scene genuinely
costs only about 146 MB there, comfortably inside even the 120 MB-plus-area allowance once the
floor is in play. An iPhone SE therefore reaches a higher tier than an iPhone 15 or an iPad,
both of which have larger, area-dominated screens.

This is not a reappearance of the inversion above: it does not put a stronger device on the
still scene while a weaker one gets everything, it only means one small, older phone affords
more of the scene than its larger, newer siblings. Real device testing should settle whether
that is acceptable or whether the floor needs its own separate tuning pass.

## Components

### `app/perf/tiers.ts` (new)

The single source of truth. Exports `TIERS` in climb order with each tier's measured overdraw
and layer count, `TILE_MIN`, the budget constants, and one pure function:

```ts
ceilingFor(vw, vh, dpr, deviceMemory, coarsePointer, tiers, tileMin, budgets): number
```

returning how many tiers fit, 0 through 4.

**`ceilingFor` must reference nothing outside its own parameters.** The head script inlines it
with `${ceilingFor.toString()}` rather than duplicating the arithmetic, because these
constants get retuned whenever the scene changes and two copies drifting apart is the
likeliest way this protection quietly stops working. A function that closes over a module
level constant would break once minified, so the constraint is load bearing and must be
stated in a comment above the function.

No DOM access, so it is directly unit testable.

### `app/perf/script.ts` (rewrite)

The inline head script. Still plain, old fashioned JavaScript in a template literal, still
wrapped in `try`/`catch`.

- Reads the `?scene=` and `?perf=` overrides and the remembered `localStorage` value, as
  today.
- Computes the ceiling via the inlined `ceilingFor`.
- **Keeps today's software renderer check.** A machine drawing without a GPU reports
  `pointer: fine` and so would be handed the large budget and every tier, and because it
  starts at its ceiling it would never climb and never be frame checked. The existing WebGL
  probe stays, and forces the ceiling to 0 when it finds no context or a software renderer.
- Always writes `data-scene-max="<n>"`.
- Writes `data-scene` to the **full** token set when nothing was cut, that is when the ceiling
  is 4. Otherwise writes `data-scene=""`.

So a device that clears the budget never climbs, and desktop behaves exactly as it does now.
Only a constrained device climbs.

On any thrown error the script falls back to tier 0. This inverts today's failure mode, where
an exception leaves the page on `full`, which is the crashing state.

### `app/perf/usePerf.ts` (rewrite)

- `useScene(token: string): boolean` over `useSyncExternalStore`, subscribing to `data-scene`.
- **The server snapshot returns `false` for every token.** The server HTML therefore becomes
  the tier 0 scene for everyone, so the pre-hydration window is cheap by construction rather
  than by CSS suppression. This is the key inversion versus today, where the server renders
  `FullScene` unconditionally.
- `setPerf('full' | 'lite')` is kept as the wallpaper's interface, used by
  `app/wallpaper/page.tsx:65`. It maps to the full token set or the empty set, and continues
  to set `data-perf-forced`.
- `useLite()` is removed. Its one remaining caller, `app/(landing)/logo/index.tsx:53`, moves
  to `useScene('depth')`.
- `watchFrameRate` moves into the climb driver below.

### `app/perf/climb.ts` (new)

The climb driver, started from `ParallaxView` on `useRevealed()`.

- Does nothing when `data-perf-forced` is present, or when `data-scene` already holds every
  token up to `data-scene-max`.
- Adds one token every 450 ms, then samples frame time for 350 ms.
- If the sampled median frame time exceeds the slow frame threshold, it removes the token it
  just added and stops. This is the second gate.
- Pauses while `document.hidden` is true, since `requestAnimationFrame` does not fire then,
  and resumes on `visibilitychange`.
- Returns a cleanup that cancels timers and frames.

**It also keeps a demotion watch, which runs whether or not anything was climbed.** A device
handed every tier up front never climbs, so without this it would never be frame checked at
all, losing the safety net `watchFrameRate` provides today. After the climb finishes, or
immediately when there was nothing to climb, the driver settles for 1000 ms, samples 60
frames, and drops one token if the median frame exceeds the threshold, repeating until the
frames are healthy or it reaches tier 0. This is today's `watchFrameRate` behaviour, preserved
and given somewhere to step down to.

### Stylesheet migration

Every `:global(html[data-perf="lite"])` rule in the nine scene stylesheets becomes a
`:global(html:not([data-scene~="<token>"]))` rule, mapped by tier:

| stylesheet | token |
| --- | --- |
| `stars/stars.module.css` | `sky` |
| `clouds/clouds.module.css` | `sky` |
| `water/water.module.css` | `water` |
| `trees/trees.module.css` | `forest` |
| `fireflies/fireflies.module.css` | `forest` |
| `night/night.module.css` | `forest` |
| `watchtower/watchtower.module.css` | `water` |
| `scroll/scroll.module.css` | `depth` |

`parallax/parallax.module.css` needs no tier rule at all. An earlier draft of this design
gated `.layer`'s `will-change: transform` on the `depth` token to kill the 122 MB
pre-hydration cost, but the server snapshot change supersedes it: the server now renders
`LiteScene`, so the markup the browser composites before hydration only ever contains that
scene's three layers. Worse, such a rule would be actively harmful, because `LiteLayer` also
uses `.layer` and does animate its transform by writing to it on scroll, so stripping the hint
would cost repaints on exactly the devices this work is meant to help.

The existing `data-still~=` rules used by the wallpaper are unrelated and stay as they are.

## Pop hazards

Climbing while the scene is on screen creates two visible transition risks.

**`depth` is a structural remount.** `LiteScene` and `FullScene` place their layers at
different parallax offsets, so swapping mid scroll is a visible jump. At `scrollY === 0` every
layer sits at offset zero and the two scenes are pixel identical. So the `depth` token is
applied **only while `scrollY === 0`**. If the visitor has already scrolled, the driver waits
for a return to the top, and abandons the `depth` tier after 30 seconds. The climb begins at
reveal, when scroll is essentially always 0, so in practice this costs nothing and removes
the one transition that would look broken.

**Only the leaves actually pop.** Reading the keyframes, most of what a token enables cannot
pop by construction. `.twinkle` starts at `opacity: 1`, which is the resting state. `.drift`
starts at `translate(0, 0)`. The clouds use `animation-play-state: paused` rather than
`animation: none`, so they hold position and resume seamlessly. `.shoot` and `.streak` sit at
`opacity: 0` for 94% and 92% of their cycles respectively, so resuming at a negative delay
almost always lands on an invisible frame, and a shooting star arriving is not a glitch.

`.leafTravel` is the exception: its keyframes hold `opacity: 1` from 8% to 85% of the cycle,
so about three quarters of the twelve leaves would appear mid flight the instant `forest`
lands. The fix is on the inner `.leafSpin` element rather than on `.leafTravel` itself,
because a `transition` and an `animation` cannot both drive opacity on one element, while
opacity across nested elements multiplies:

```css
.leafSpin { transition: opacity 600ms ease; }
:global(html:not([data-scene~="forest"])) .leafSpin { opacity: 0; }
```

`.shoot` keeps its `display: none` below the `sky` token, which is better than going still,
because a non-displayed element gets no composited layer at all.

## Overrides and testing hooks

- `?perf=lite` and `?perf=full` keep working, mapping to no tokens and all tokens, and keep
  being remembered in `localStorage` as today. `?perf=auto` returns to detection.
- `?scene=depth+sky` forces an exact token set, for testing a specific tier.

## Error handling

| case | behaviour |
| --- | --- |
| head script throws | falls back to tier 0, the safe state |
| `localStorage` unavailable | caught and ignored, detection proceeds |
| `navigator.deviceMemory` undefined | `memFactor` of 1, the conservative middle |
| tab hidden during climb | climb pauses, resumes on `visibilitychange` |
| frame sample exceeds threshold | last token removed, climb stops permanently |
| visitor scrolled before `depth` applies | waits for `scrollY === 0`, gives up after 30 s |

## Testing

**Unit, vitest (new dev dependency).** `ceilingFor` is pure and DOM free, and is where the
tier arithmetic and budget boundaries live. Cases: each row of the budget table above; the
boundary either side of every tier; `deviceMemory` undefined; `clamp` at both ends; degenerate
viewports; a `tiers` array of length zero.

**Cost measurement, `scripts/scene-cost.js` (new), alongside the existing `wallpaper.mjs`.**
A browser console snippet, not a Node script: it prints the overdraw and layer count per scene
part, reproducing the table in this document so the constants in `tiers.ts` can be re-derived
when the scene changes. Driving a real browser from Node would mean pulling in Playwright or
Puppeteer, which is a heavy dependency for a project that currently has no browser tooling at
all, and the snippet needs a real page with real layout either way. Without some form of this
the constants rot the first time the scene changes, and the failure mode is silent.

**Manual verification, required before merge.** The constants cannot be validated from a
development machine, because the failure being fixed is an iOS renderer kill. Load the branch
on a real phone and confirm the page no longer crashes, note which tier it settles at, and
check that `?perf=full` still reproduces the crash so we know the fix is what changed the
outcome.

**Regression check on desktop.** Confirm `data-scene` is written with all four tokens by the
head script, that the climb driver does not run, and that the scene is visually unchanged from
`Master`.

## Future work, out of scope

The `sky` tier costs 8.43 viewports, more than everything except the parallax itself. The
reason is that each twinkle group's stars are assigned randomly across the whole sky, so every
group's bounding box is nearly the full canvas width and each of the 14 star layers is roughly
a full viewport. Grouping stars spatially rather than randomly would shrink those boxes
dramatically and could bring `sky` within reach of a normal phone. That is a change to
`stars/index.tsx` and its group construction, not to the tier system, so it is deliberately
left out of this work.
