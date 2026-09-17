import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'

import { SITE } from './site'

// The link preview for the site (see opengraph-image.tsx and twitter-image.tsx): the night scene with the hero's logo
// row over it, set the way the hero sets it. Made once, at build time.

export const SHARE_SIZE = { width: 1200, height: 630 }
export const SHARE_ALT = `${SITE.name}: ${SITE.tagline}`

// The hero's logo row (app/(landing)/logo), at the size the site draws it at and in the place it settles into: the
// icon, a 20px gap, then an 800px block holding the title with the subtitle tucked up under it. Everything is placed
// from the title's line box, since that is what the hero's own offsets are measured against, and laid out absolutely
// so none of it rests on this renderer matching a browser's flex and margin behaviour.
//
// The row is 960px wide, which leaves an even margin either side of the 1200px canvas, so it is used at its own size.
const ROW = { width: 960, height: 176.6 }
const GAP = 20
const TEXT_WIDTH = 800
const ICON = { size: 140, top: 30.3 }
const TITLE = { size: 128, weight: 700 as const, tracking: 10, lineHeight: 1.167 }
const SUBTITLE = { size: 36, weight: 300 as const, tracking: 11, lineHeight: 1.2, top: 133.4, indent: 8 }
// The row sits a little above centre, in the gap the mountains leave in the sky
const RISE = 46

const dataUrl = async (path: string, type: string) =>
    `data:${type};base64,${(await readFile(join(process.cwd(), path))).toString('base64')}`

// Montserrat, as on the site, from Google Fonts (the build already fetches it there for next/font). Without it the
// image falls back to the default typeface rather than failing the build.
async function montserrat(weight: typeof TITLE.weight | typeof SUBTITLE.weight, text: string) {
    try {
        const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Montserrat:wght@${weight}&text=${encodeURIComponent(text)}`)).text()
        const src = css.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/)?.[1]
        if (!src) return null
        return { name: 'Montserrat', data: await (await fetch(src)).arrayBuffer(), weight, style: 'normal' as const }
    } catch {
        return null
    }
}

export async function renderShareImage() {
    const title = SITE.name.toUpperCase()
    const [backdrop, logo, bold, light] = await Promise.all([
        dataUrl('public/images/mountains.jpg', 'image/jpeg'),
        dataUrl('public/images/logo.png', 'image/png'),
        montserrat(TITLE.weight, title),
        montserrat(SUBTITLE.weight, SITE.tagline),
    ])

    return new ImageResponse(
        (
            <div style={{ position: 'relative', display: 'flex', width: '100%', height: '100%', backgroundColor: SITE.colour, color: 'white', fontFamily: 'Montserrat' }}>
                {/* The scene, and a soft darkening behind the text so it reads at thumbnail size */}
                {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
                <img src={backdrop} width={1200} height={675} style={{ position: 'absolute', top: -20, left: 0 }} />
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', background: 'radial-gradient(ellipse 70% 55% at 50% 44%, rgba(11,16,31,0.55), rgba(11,16,31,0) 100%)' }} />

                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: RISE }}>
                    <div style={{ position: 'relative', display: 'flex', width: ROW.width, height: ROW.height }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={logo} width={ICON.size} height={ICON.size} alt="" style={{ position: 'absolute', left: 0, top: ICON.top }} />

                        <div style={{ position: 'absolute', left: ICON.size + GAP, top: 0, width: TEXT_WIDTH, fontSize: TITLE.size, fontWeight: TITLE.weight, letterSpacing: TITLE.tracking, lineHeight: TITLE.lineHeight, textShadow: '0 4px 30px rgba(11,16,31,0.6)' }}>
                            {title}
                        </div>

                        <div style={{ position: 'absolute', left: ICON.size + GAP + SUBTITLE.indent, top: SUBTITLE.top, width: TEXT_WIDTH, fontSize: SUBTITLE.size, fontWeight: SUBTITLE.weight, letterSpacing: SUBTITLE.tracking, lineHeight: SUBTITLE.lineHeight, textShadow: '0 2px 16px rgba(11,16,31,0.8)' }}>
                            {SITE.tagline}
                        </div>
                    </div>
                </div>
            </div>
        ),
        { ...SHARE_SIZE, fonts: [bold, light].filter(f => f !== null) },
    )
}
