This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Wallpaper Engine

The hero scene is also a [Wallpaper Engine](https://www.wallpaperengine.io/) web wallpaper (`app/wallpaper`, viewable at
`/wallpaper`), with the layers following the mouse instead of the scroll, and the time, date and weather in place of the
title. The weather is from [Open-Meteo](https://open-meteo.com/), for a place set in the wallpaper's settings or, when
none is, roughly located from the IP address with [GeoJS](https://www.geojs.io/). Beneath those it shows what's playing on the
computer (Spotify, a browser or most music apps) through Wallpaper Engine's media integration, which is switched on in
Wallpaper Engine's own settings. The sound itself rises out of the mountains, each line standing
below the skyline where it is so only what clears it shows, as bars or a wave.

```bash
npm run wallpaper
```

This builds it into `dist/wallpaper-engine`. In Wallpaper Engine, open the editor ("Create Wallpaper"), choose
`dist/wallpaper-engine/index.html`, and it can be saved or published to the Workshop from there. Its settings are defined
in `wallpaper-engine/project.json`: the time (12- or 24-hour, seconds), date and weather (location, units, high and low)
what's playing, its progress and where it sits, the audio visualiser's style,
height, colour and opacity, and their size, mouse parallax and its strength, and the scene's motion, all at once or part by part (clouds, stars,
shooting stars, wind, fireflies, water, the watchtower's light). They can be tried in a browser with query parameters
named as in `app/wallpaper/settings.ts`, e.g. `/wallpaper?hours=24&seconds=1&location=Perth, AU&size=80&wind=0&still=1`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## The hero scene and performance

The hero is served in four cumulative tiers (`depth`, `sky`, `forest`, `water`), marked on `<html data-scene="...">`
by a script in the page head before anything is drawn, from a budget of what the device can hold. Layers that follow
the scroll directly are moved by the browser itself through a CSS scroll timeline, which is what keeps phones smooth.
A device that crashes on screen is held to the `depth` tier on its next visit. The full reasoning, with the
measurements behind it, is in `docs/superpowers/specs/2026-09-18-staged-scene-tiers-design.md`.

### Diagnosing it on a device

These all work on the live site, which matters on a phone that can't be attached to a profiler:

| URL | what it does |
| --- | --- |
| `?debug=perf` | a readout of frames drawn and scroll events per second, the worst frame, the tier, scroll timeline support, the iOS version and any crash cap, plus switches that each take one suspect out of the picture. Also turns on the crash guard's log, which records every load from then on and shows in the readout |
| `?debug=off` | turns the crash guard's log back off, and deletes it |
| `?scene=depth+water` | forces exactly those tiers, for this visit only |
| `?perf=lite` or `?perf=full` | forces the still or the whole scene, **remembered in this browser** until `?perf=auto` |
| `?perf=auto` | back to detection, and forgets an old crash cap (but not a crash that has only just happened) |

Combine them freely, for example `?debug=perf&scene=depth` to watch the readout at a pinned tier. Remember to finish
with `?perf=auto` after using `?perf=lite` or `?perf=full`, since both stick.

### Measuring the scene

How far a browser climbs depends on cost constants in `app/perf/tiers.ts`. If you add or remove moving parts,
re-derive them: paste `scripts/scene-cost.js` into the browser console on the home page and compare runs at different
`?scene=` token sets. The difference between two runs is what that tier costs.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
