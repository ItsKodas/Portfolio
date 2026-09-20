# Replacing MUI with our own UI library

Date: 2026-09-20
Status: approved design, not yet implemented
Related: `2026-09-20-client-portal-screens-design.md` (the screens this serves)

## What this is

The site uses MUI 6 behind sign-in and Tailwind on the public pages, with three separate MUI themes, two of
which are byte-identical copies. The portal screens designed in the mockups want a density MUI fights, and
their real components (a severity rail, a deploy trail, meters, a log pane, an env editor, a deploy history)
are custom under any plan.

This replaces MUI with a small library of our own, in one pass, and removes `@mui/material`,
`@mui/icons-material`, `@mui/material-nextjs`, `@emotion/react`, `@emotion/styled` and `@emotion/cache`.

## What is actually there

Measured, not estimated. 29 files import MUI, and the usage is dominated by components that carry no
behaviour:

| What | Uses | What replacing it costs |
| --- | --- | --- |
| `Typography`, `Box`, `Stack`, `Paper`, `Container` | 113 | Nothing. They are elements with styles |
| `Button`, `Link` | 56 | Nothing |
| `Table` and its parts | 54 | Nothing. Plain table elements are already semantic |
| `TextField` | 22 | Real work: label association, error wiring, invalid state |
| `Alert`, `Chip` | 20 | Little |
| `Dialog` | 3 | Focus trapping, which the native `dialog` element now does |
| `Tooltip`, `Menu` | 2 | Some keyboard handling |
| `@mui/icons-material` | 26 distinct icons | Sourcing or drawing 26 icons |

The public pages use MUI lightly: a `ThemeProvider`, `Typography`, and icons. Converting them removes
emotion's runtime from the landing bundle, which helps the scene rather than threatening it.

## Scope

### In scope

- A tokens module, one source of truth for colour, type, radius and density
- A component library under `ui/`
- Converting all 29 files, the public pages and the wallpaper included
- Replacing the 26 icons
- Removing the six packages
- Component tests, which do not exist today

### Not in scope

- Any change to the landing scene's artwork, its CSS modules or the perf tier system
- The portal screens themselves, which are blocked on hostd and designed separately
- Tailwind, which stays for the public pages

## Decisions

**CSS Modules, not Tailwind utilities.** `tailwind.config.ts` sets `important: true`, deliberately: the perf
work in `globals.css` depends on utilities outscoring a bare `*` selector. Every utility therefore carries
`!important`, which makes composition and per-instance overrides painful, exactly what a component library
needs. The app already has 16 CSS modules in the landing scene, so this is the codebase's existing pattern
rather than a new one. Tailwind stays where it already works.

**Tokens are CSS custom properties, with a TypeScript mirror.** Declared once on `:root` in `globals.css`, so
a component's stylesheet reads `var(--lake)` and nothing imports a theme object to render. The TypeScript
export exists for the few places a value is needed in script, such as a meter's fill. One list, two
readers, and a test asserting they agree.

**No theme provider, and no runtime style engine.** Emotion's cache provider exists today only to stop MUI
flashing unstyled content on the server. CSS modules ship as static CSS, so the problem disappears with the
dependency.

**Density is a token set, not a second theme.** The mockups' split personality is one visual language at two
densities: the operator's side dense, the client's side roomy. That is a handful of spacing and font-size
tokens, applied by a `data-density` attribute on the area's layout. Two themes is what produced three drifting
theme files; one token set with a switch cannot drift.

**The landing keeps its own two surface colours.** `themes/dark.ts` uses `#101727` and `#0b0d1c`, tuned to the
scene art, not the portal's `#0b101f` and `#111a38`. Those move into the tokens module as their own named
pair rather than being unified away. Recorded as a deliberate exception so nobody later "fixes" it.

**Dialogs use the native `dialog` element.** `showModal()` gives focus trapping, Escape, inertness of the rest
of the page and a top layer that no z-index can fight. This is the one place MUI was doing something genuinely
hard, and the platform now does it better.

**Icons are our own inline SVGs.** Swapping `@mui/icons-material` for another icon package trades one
dependency for another. 26 icons, drawn once as components with a shared size and `currentColor` fill, is a
small file and removes the question permanently. The weather and social icons on the wallpaper are the bulk of
them and change rarely.

## Architecture

`ui/` at the repo root, mirroring `server/`, reached as `@/ui/...` through the existing `@/*` alias.

```
ui/
  tokens.css          the custom properties, imported by globals.css
  tokens.ts           the TypeScript mirror, and the density scales
  tokens.test.ts      asserts the two agree
  <Component>/        one folder each: the component, its module.css, its test
  icons/              26 inline SVG components
```

### The tokens

| Group | Values |
| --- | --- |
| Surfaces | `night #0b101f`, `deep #0d1429`, `panel #111a38`, `panelHi #16224a`, `rule #1f2b52`, `ruleHi #2c3c6e` |
| Scene surfaces | `sceneBg #101727`, `scenePaper #0b0d1c`, for the landing and wallpaper only |
| Ink | `ink #eef2ff`, `ink2 #a9b6dd`, `ink3 #6f7da8`, blue-biased rather than grey |
| Accent | `lake #8fd4f5` interactive, `blush #f19bb3` reserved for "a person did this" |
| Status | `good #6fd39b`, `warn #f0b45c`, `crit #f4685f`, `softRed #ffb3ad` for critical text on dark |
| Type | Montserrat for the interface, IBM Plex Mono for machine text only |
| Radius | 4 chips, 7 controls, 9 panels, 11 cards. A scale, not one value |
| Density | two scales, `operator` and `client`, switched by `data-density` |

IBM Plex Mono is added to the root layout with `next/font`, beside Montserrat, both exposed as CSS variables
so a stylesheet can name them without inheriting.

### The components

Accessibility is the only thing MUI was giving us that is hard to reproduce, so each component's obligations
are written down rather than left to whoever builds it.

| Component | Must do |
| --- | --- |
| `Button` | A real `button`, `type` always set, visible focus ring from the shared token |
| `Field` | Label tied by `id`, hint and error tied by `aria-describedby`, `aria-invalid` when in error, error text never colour-alone |
| `Dialog` | Native `dialog` with `showModal()`, labelled by its heading, focus returned to the opener on close |
| `Table` | Real table elements, `scope` on every header cell, a caption or `aria-label` |
| `Tabs` | Roving `tabindex`, arrow keys, `aria-selected`, `aria-controls` |
| `SegmentedControl` | A radio group, not buttons, so arrow keys work and the state is announced |
| `Menu` | Arrow keys, Escape closes and returns focus, `aria-expanded` on the trigger |
| `Chip`, `Callout` | Status carried by an icon or a word as well as colour, never colour alone |
| `Tooltip` | Reachable by keyboard, never the only carrier of meaning |
| `StatusDot`, `Meter`, `LogPane`, `Trail`, `KeyValue` | Portal-specific, no MUI equivalent, drawn from the mockups |

## Migration order

Each step leaves the app building and the existing server tests green.

1. **Tokens and fonts.** `ui/tokens.css`, `ui/tokens.ts`, IBM Plex Mono in the root layout. Nothing else
   changes yet.
2. **Primitives**, with their tests: `Button`, `Field`, `Chip`, `Callout`, `Dialog`, `Table`, `Tabs`,
   `SegmentedControl`, `Menu`, `Tooltip`.
3. **Icons**, all 26.
4. **The public pages and the wallpaper.** Light MUI use, no forms, and the perf win lands early.
5. **The admin area**, starting with the quote inbox and its quote page. Read-mostly screens with one dialog.
6. **The client admin pages** under `(admin)/admin/clients`.
7. **The auth flows last**: sign-in, invite, reset, setup, forgot, account. The riskiest, and by then the
   library has been exercised on everything else.
8. **Remove the six packages** and the emotion cache provider from both layouts.

Nothing in the portal's future screens should be built on MUI in the meantime.

## Testing strategy

**There are no component tests today.** `vitest` is configured and `server/` is well covered, but not one
`.test.tsx` exists. Rewriting 29 files of UI with no safety net is the main risk this plan carries, so the
tests come with the components rather than after them.

Add `@testing-library/react` and run it under the existing vitest setup.

- **Every a11y obligation above is a test.** A label that is not tied to its input, a dialog that does not
  return focus, tabs that ignore arrow keys: these fail silently in review and are exactly what MUI was
  preventing.
- **The tokens test** asserts the CSS and TypeScript lists agree, so a colour cannot be added to one and
  missed in the other.
- **The auth flows get a test each before they are converted**, covering the path a person actually takes:
  submit empty, submit wrong, submit right, and the error text that appears. They are being rewritten for no
  user-visible benefit, so the bar is that nothing changes.
- **`npm run build`, `npm run wallpaper`, `npm run lint` and `npx tsc --noEmit`** all pass at every step. The
  wallpaper export is the one most likely to break quietly.

## Known risks and accepted weaknesses

| Risk | Why it is accepted, or what limits it |
| --- | --- |
| Part 2's auth flows are rewritten for no user-visible gain | Chosen deliberately over converting new screens first, to avoid running two systems side by side. The cost is real: TOTP, recovery codes and password reset shipped days ago and work. They are converted last, behind tests written first. |
| 29 files of UI are rewritten with no existing test coverage | The largest risk here. Answered by writing tests as part of the work rather than after, and by ordering the riskiest screens last. |
| Accessibility regressions are silent | Which is why each component's obligations are written above and each is a test. A component that passes its test is not automatically accessible, but the failures MUI was preventing are the ones listed. |
| 26 icons to draw | Mechanical, and most are the wallpaper's weather and social icons, which rarely change. |
| Tailwind and CSS modules coexist | Already true today, and the boundary is clear: Tailwind on the public marketing pages, CSS modules for the library. |
| The perf tier system depends on selector weight in `globals.css` | Nothing in this plan changes `important: true` or those rules. The landing scene's own CSS modules are not touched. |
