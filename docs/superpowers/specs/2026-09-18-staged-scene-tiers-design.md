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
| raster memory at DPR 3 | about 220 MiB | about 39 MiB |

220 MiB of compositor raster is past the point where mobile Safari and Chrome kill the
renderer process. This is a memory ceiling, not a framerate ceiling, which matters because
the only existing fallback watches frame rate.

The fallback in `watchFrameRate` (`app/perf/usePerf.ts`) cannot run until the loading curtain
lifts (up to 5000 ms), then the `load` event fires, then a 1000 ms settle passes, then 60
frames are sampled. At 10 fps those 60 frames alone take 6 seconds. The earliest realistic
switch is 7 to 12 seconds after navigation. The tab dies during the first composite, long
before any of that.

A secondary contributor: `.layer` in `app/(landing)/parallax/parallax.module.css` carries
`will-change: transform` unconditionally. Even with `data-perf="lite"` set by the head script,
the pre-hydration window still costs 21 layers, 11.7 viewports of overdraw and about 122 MiB,
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
paint. The server HTML is composited before hydration, measured at about 122 MiB even with
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
| 4 | `forest` | tree sway, gusts, wind streaks, leaves, fireflies | +0.2 | +162 |

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

**Every byte figure in this document is MiB**, that is 1024 x 1024 bytes, which is the unit the
budget constants in `tiers.ts` are written in (`120 * 1024 * 1024`). Nothing here is decimal MB.

At 375x812 and DPR 3, one viewport of overdraw is about 10.5 MiB, giving these cumulative
figures, computed from the formula above rather than measured:

| through tier | added | cumulative |
| --- | --- | --- |
| 0 base | about 48 MiB | about 48 MiB |
| 1 `depth` | about 75 MiB | about 123 MiB |
| 2 `sky` | about 111 MiB | about 234 MiB |
| 3 `water` | about 15 MiB | about 249 MiB |
| 4 `forest` | about 43 MiB | about 292 MiB |

### Known limitation: `night`'s layers are booked against the wrong tier

The layer counts above were measured with `night/night.module.css` gated on the `forest`
token, the same as the other footer elements, so its animated layers were counted into
`forest`'s +162. `night` has since moved to the `depth` token instead (see Stylesheet
migration and Components, below), because the campfire and the content area's background
stars sit below the hero and gained nothing from being frozen on every phone. The counts in
`TIERS` have not been re-derived to match.

`night` puts 43 animated elements on screen (30 twinkling stars, one glow, three flames, nine
sparks), which `scripts/scene-cost.js` would count as 43 layers, about 10.8 MiB at `TILE_MIN`.
After the move, tier 1 `depth` carries that weight and tier 4 `forest` no longer does, but
`TIERS` still books it the old way.

This is an accounting inaccuracy, not an observed problem. No modelled device in the table
below changes tier as a result: a device that clears all four tiers spends the same total
either way, since moving a layer count between tiers does not change the sum across all of
them, and every device that stops short of `forest` keeps a positive margin. The tightest is
the iPhone SE, which stops at `water` (see the residual below): its headroom there against the
120 MiB touch floor falls from about 14.9 MiB to about 4.2 MiB once the 43 layers are counted
where they now belong, closer to the floor but not past it.

The real-browser effect is smaller than the model suggests, because a composited layer outside
the viewport gets no backing store allocated until it scrolls into view, and the crash this
design fixes happens at the top of the page, before the footer is anywhere near the viewport.

On a touch device the question is now moot: `night`'s animations are switched off there at
every tier (see Scroll-time cost on touch devices, below), so those 43 layers are never
promoted on a phone at all. The inaccuracy remains only for pointer devices, whose budget has
several hundred MiB of headroom.

Re-running `scripts/scene-cost.js` with `night` on `depth` would settle this properly; until
then, treat `depth` and `forest`'s layer counts in `TIERS` as approximate.

## The budget

```
budget    = allowance x memFactor
allowance = coarsePointer ? max(120 MiB, viewportBytes x 14)
                          : max(1024 MiB, viewportBytes x 26)
memFactor = navigator.deviceMemory ? clamp(deviceMemory / 4, 0.5, 1.5) : 1
```

Both branches have the same shape: the larger of a floor and an allowance that scales with the
device's own screen, in viewports of the same `vw x vh x dpr^2 x 4` term the cost model uses.
The floor exists so a small screen is not starved down to nothing; the area term exists so a
large screen is not held to the same ceiling as a small one.

The touch floor is 120 MiB over 14 viewports; the pointer floor is 1024 MiB over 26. 26 sits
above the 21.9 viewports of cumulative full-scene overdraw, so a pointer device in the area
regime keeps real headroom over the whole scene rather than scraping it.

### Why the shape changed

An earlier version of this budget was one fixed byte ceiling per pointer kind: `160 MiB` for
touch, `1024 MiB` for a mouse, with `memMax` at `1.75`. That was wrong in a way that only shows
up once you check it against real device geometries rather than one synthetic viewport.

Safari reports no `navigator.deviceMemory` at all: not on iOS, and not on macOS either. So
every device in Safari shared its one fixed ceiling, while the scene's cost scales with
viewport area times `dpr^2`. A bigger screen means a newer, more capable device far more often
than it means a weaker one. A fixed ceiling therefore penalised exactly the devices best able
to cope, at both ends of the range:

- On touch, an iPhone SE landed at the top tier while an iPad Pro, the strongest device in the
  sweep, landed on the still scene with nothing. Sweeping the old constants found no
  combination that avoided this: the iPad Pro reached tier 0 and the iPhone SE reached tier 3
  or 4 in every one tried.
- On pointer, a Studio Display (2560x1340, DPR 2) and a Pro Display XDR (3008x1590, DPR 2) both
  fell to the `depth` tier alone in Safari, while a MacBook Pro 16 at half the area reached all
  four. The `memFactor` multiplier hid this in Chrome, which does report `deviceMemory`, and
  did nothing at all in Safari, which does not.

It was the shape of the model that was backwards, not its values, which is why this amendment
changes the formula rather than retuning the constants.

Separately, the old `memMax` of `1.75` let an 8GB Android reach a budget of 280 MiB
(`160 MiB x 1.75`). That number and the one it is compared against are both computed from this
model's formula, not measured, and it matters which is which:

- The crash itself is **observed**: a real phone gets its tab killed. The exact byte count at
  which a renderer is killed is not known to us; browsers do not report it.
- 220 MiB (see Problem, above) is **measured**: summed in a real browser from each composited
  layer's area clipped to the viewport, at 375x812 DPR 3. It is area only, and does not include
  the `layers x TILE_MIN` term this model adds.
- 292 MiB is **computed**: it is what this model's formula gives for the full scene, all four
  tiers, at that same 375x812 DPR 3 geometry, including the tile term the 220 MiB figure omits.
  It is larger than 220 MiB because it is a fuller accounting of the same scene, not a different
  measurement of it.
- 280 MiB is also **computed**: the old model's fixed touch ceiling at its old `memMax`. The
  old touch branch ignored geometry entirely, so this was every 8GB Android's budget, whatever
  its screen.

So the claim that stands up is: the full scene, the configuration observed crashing on a real
device, computes to about 292 MiB under this model, and the old model handed an 8GB Android a
budget of 280 MiB, within 4% of that. Neither 292 MiB nor 280 MiB is a measured kill threshold.
`memMax` now drops to `1.5`, which was chosen to widen that margin rather than leave it this
close.

Which lands as:

| device | geometry | signals | tier reached |
| --- | --- | --- | --- |
| iPhone SE | 375x667, DPR 2 | coarse, no `deviceMemory` | 3, `water` |
| iPhone 15 | 393x852, DPR 3 | coarse, no `deviceMemory` | 1, `depth` |
| iPhone 15 Pro Max | 430x932, DPR 3 | coarse, no `deviceMemory` | 1, `depth` |
| iPad 10.9 | 820x1180, DPR 2 | coarse, no `deviceMemory` | 1, `depth` |
| Pixel 8 | 412x915, DPR 2.625 | coarse, `deviceMemory` 8 | 1, `depth` |
| mid range Android | 375x812, DPR 3 | coarse, `deviceMemory` 4 | 1, `depth` |
| low end Android | 360x800, DPR 3 | coarse, `deviceMemory` 2 | 0, still scene |
| MacBook Pro 16 | 1728x970, DPR 2 | fine, no `deviceMemory` | 4, all tiers |
| Studio Display | 2560x1340, DPR 2 | fine, no `deviceMemory` | 4, all tiers |
| Pro Display XDR | 3008x1590, DPR 2 | fine, no `deviceMemory` | 4, all tiers |
| desktop Chrome | 1920x1080, DPR 2 | fine, `deviceMemory` 8 | 4, all tiers |

**Touch devices do not all land on tier 1**, and which regime a device falls in is what decides
it. Most phones and tablets are in the area regime, where the screen is big enough that
`viewportBytes x 14` beats the 120 MiB floor, and they settle at `depth`: there the tier
reached converges on whichever cumulative overdraw ratio first exceeds 14, independent of size,
and cumulative overdraw is 10.8 through `depth` but 20.8 through `sky`. Either side of that
regime the answer differs. A small enough screen sits under the floor and reaches tier 3 (see
the residual below), and a device whose `deviceMemory` drags `memFactor` down to 0.5 can fall
short of even `depth` and stay on the still scene.

These are starting values. They are chosen so that no touch device reaches the state that
currently crashes, and so that every pointer driven device clears all four tiers and behaves
exactly as the site does today. They will need tuning against real hardware, which is why
they live in one file with their reasoning in comments.

Note that `sky` is expensive enough (10.0 viewports, of which the stars alone are 8.43) that
most phones will settle at `depth`. See Future work.

### Residual: the iPhone SE still reaches a higher tier than other phones

One quirk survives this change and is left as-is. On a 375x667, DPR 2 screen, the area term is
small enough that the 120 MiB floor governs rather than `viewportBytes x 14`, and the per-layer
tile minimums dominate the cost. Cumulatively, and **computed** (not measured, this model's
formula only), that screen holds the scene through `water` at about 105 MiB, inside the floor.
It stops there: `forest`'s 162 layers are almost no area but 162 tiles, which takes the total to
about 146 MiB, past the floor. So the SE reaches tier 3, `water`, where an iPhone 15 or an iPad,
both of which have larger, area-dominated screens, reach tier 1.

This is not a reappearance of the inversion above: it does not put a stronger device on the
still scene while a weaker one gets everything, it only means one small, older phone affords
more of the scene than its larger, newer siblings. Real device testing should settle whether
that is acceptable or whether the floor needs its own separate tuning pass.

## Scroll-time cost on touch devices

The budget models memory, and memory was what crashed the tab. It says nothing about what
scrolling costs per frame, and on a phone that turned out to be the next problem: with the
crash fixed, a phone at `depth` held a steady frame rate at rest and fell apart as soon as it
was scrolled. Three things made that invisible to the design above.

- **The frame watch only ever sampled at rest.** It ran once, about a second after the scene
  settled at the top of the page, and a healthy result ended it. Nobody has scrolled by then.
- **Reaching `depth` turned on more than depth.** Every layer type decision keyed off `lite`,
  meaning "not `depth`", so a phone at tier 1 also got react-spring layers (ten hero depths and
  the content column, each restarted on every scroll event with `config.slow` and still
  settling for about a second afterwards), frosted glass (25 blurred surfaces in the content,
  each re-blurred every scroll frame because the scene behind moves at a different speed), and
  a hero that kept drawing after it was scrolled past, since taking it out of drawing was also
  tied to `lite`.
- **The campfire and night stars animated at tier 1**, having moved to the `depth` token.

None of these cost memory at rest, which is why the budget passed them. A machine drawing
without a GPU never saw any of it, because it is held at tier 0, where every one of them is off:
that is why a desktop with hardware acceleration disabled scrolled smoothly while a phone did
not.

A touch device, meaning `(pointer: coarse)`, the same test the budget already branches on,
therefore keeps the ten-depth parallax but loses what costs a frame on every scroll:

| on a touch device | how |
| --- | --- |
| every layer, hero and content, follows the scroll directly rather than springing after it | `useCoarsePointer()` in `usePerf.ts`; `ParallaxView` passes `LiteLayer` to `FullScene` |
| the hero is taken out of drawing once the content covers it | tied to direct layers now, not to `lite`, since only springing layers trail the scroll |
| no frosted glass | `@media (pointer: coarse)` in `app/globals.css` |
| no campfire or night stars | `@media (pointer: coarse)` in `night/night.module.css` |

and the frame watch now samples real scrolls (see `app/perf/climb.ts`, below), so a device that
still struggles steps down rather than staying slow. Pointer devices are unchanged: springs,
frosted glass and the campfire all remain from `depth` up.

`tailwind.config.ts` sets `important: true`, so every Tailwind utility is `!important`,
`backdrop-blur-md` included. Between two `!important` rules specificity decides, so a bare `*`
loses to a single class. Both rules that switch the blur off carry at least (0,1,1): the tier 0
rule by its shape, and the touch rule as `html:root *`.

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
- Applies a tier, waits `STEP_MS` (450 ms), then samples `CLIMB_FRAMES` (20) drawn frames and
  takes their median. The wait comes before the sample at every step, the first included, so
  the `depth` tier settles the same way a later one does: sampling it immediately would catch
  the scene's remount while the curtain fade and the logo's intro were still in flight, and
  the one way ratchet would make that false demotion permanent for the rest of the visit.
- If the sampled median frame time exceeds the slow frame threshold, it reverts to the tier it
  had before this step, then hands off to the demotion watch below rather than climbing
  further. This is the second gate.
- Effectively pauses while `document.hidden` is true: `sampleFrames` resets its baseline the
  next time it ticks while hidden rather than counting the gap as a frame delta. It does not
  listen for `visibilitychange`.
- Returns a cleanup that cancels timers and frames.

**It also keeps a demotion watch, which runs whether or not anything was climbed.** A device
handed every tier up front never climbs, so without this it would never be frame checked at
all, losing the safety net `watchFrameRate` provides today. After the climb finishes, or
immediately when there was nothing to climb, the driver settles for 1000 ms, samples 60
frames, and drops one token if the median frame exceeds the threshold, repeating until the
frames are healthy or it reaches tier 0. This is today's `watchFrameRate` behaviour, preserved
and given somewhere to step down to.

**Then it watches scrolling, for the rest of the visit.** A healthy result at rest used to end
the watch, but frames at rest say little about scrolling, which is where a phone struggles
(see Scroll-time cost on touch devices, below). So passing the at-rest check hands over to a
scroll watch instead. A frame counts only when a scroll event has landed since the one before
it, so nothing is sampled, and no frame of its own is requested, while the page sits idle;
each gesture starts from a fresh baseline so the gap between gestures is never measured, and
a hidden tab resets it the same way. Every `SCROLL_FRAMES` (30) such frames, gathered across
gestures, it takes the median and steps down one tier if it is slow, then carries on watching
at the new tier. It does not run at tier 0, where there is nothing left to drop.

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
| `night/night.module.css` | `depth` |
| `watchtower/watchtower.module.css` | `water` |
| `scroll/scroll.module.css` | `depth` |

`parallax/parallax.module.css` needs no tier rule at all. An earlier draft of this design
gated `.layer`'s `will-change: transform` on the `depth` token to kill the 122 MiB
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
layer sits at offset zero and the two scenes are pixel identical, and once the content has
scrolled up over the hero completely neither scene can be seen at all. So the `depth` token
is only ever added or removed at one of those two moments. `ParallaxView` owns that geometry
and hands the driver a `canSwapScene()` check (at the top, or the hero fully covered, the
same threshold at which a direct-layer hero is taken out of drawing). If neither comes, the
climb abandons `depth` after 30 seconds, while a step down away from `depth` goes ahead
anyway, since a device that is already struggling should not stay that way indefinitely.

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

One more consequence of the `:not()` form worth writing down: `html:not([data-scene~="depth"])
*` in `app/globals.css` (the rule that strips `backdrop-filter` below `depth`) matches just as
much when `data-scene` is absent as when it is present without the token. With JavaScript
disabled the head script never runs, so `data-scene` is never written, and the site now renders
without the frosted glass panels it used to keep in that case. That is the intended direction,
consistent with tier 0 being the no-JS state, but it was never stated outright until now.

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
| tab hidden during climb | `sampleFrames` resets its baseline on the next tick, effectively pausing |
| frame sample exceeds threshold | reverts to the tier before, then hands off to the demotion watch |
| visitor scrolled before `depth` applies | waits for `canSwapScene()`, gives up after 30 s |

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

The `sky` tier adds 10.0 viewports, more than any other tier adds, and 8.43 of those are the
stars alone, the clouds making up the rest. The reason the stars are that expensive is that
each twinkle group's stars are assigned randomly across the whole sky, so every
group's bounding box is nearly the full canvas width and each of the 14 star layers is roughly
a full viewport. Grouping stars spatially rather than randomly would shrink those boxes
dramatically and could bring `sky` within reach of a normal phone. That is a change to
`stars/index.tsx` and its group construction, not to the tier system, so it is deliberately
left out of this work.
