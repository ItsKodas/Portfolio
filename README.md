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
none is, roughly located from the IP address with [GeoJS](https://www.geojs.io/).

```bash
npm run wallpaper
```

This builds it into `dist/wallpaper-engine`. In Wallpaper Engine, open the editor ("Create Wallpaper"), choose
`dist/wallpaper-engine/index.html`, and it can be saved or published to the Workshop from there. Its settings (which of
the time, date and weather show, clock format, weather location and units, mouse parallax and strength, still scenery)
are defined in `wallpaper-engine/project.json`, and can be tried in a browser with query parameters, e.g.
`/wallpaper?hours=24&location=Perth, AU&units=fahrenheit&weather=0&strength=80&still=1`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
