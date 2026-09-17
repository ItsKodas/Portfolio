import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'

import { SITE } from './site'

// The link preview for the site (see opengraph-image.tsx and twitter-image.tsx): the night scene with the logo and title
// over it, much as the hero opens. Made once, at build time.

export const SHARE_SIZE = { width: 1200, height: 630 }
export const SHARE_ALT = `${SITE.name}: ${SITE.author}, ${SITE.role}`

const dataUrl = async (path: string, type: string) =>
    `data:${type};base64,${(await readFile(join(process.cwd(), path))).toString('base64')}`

// Montserrat, as on the site, from Google Fonts (the build already fetches it there for next/font). Without it the
// image falls back to the default typeface rather than failing the build.
async function montserrat(weight: number, text: string) {
    try {
        const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Montserrat:wght@${weight}&text=${encodeURIComponent(text)}`)).text()
        const src = css.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/)?.[1]
        if (!src) return null
        return { name: 'Montserrat', data: await (await fetch(src)).arrayBuffer(), weight: weight as 600 | 700, style: 'normal' as const }
    } catch {
        return null
    }
}

export async function renderShareImage() {
    const title = SITE.name.toUpperCase()
    const subtitle = `${SITE.author} · ${SITE.role}`.toUpperCase()
    const [backdrop, logo, bold, semibold] = await Promise.all([
        dataUrl('public/images/mountains.jpg', 'image/jpeg'),
        dataUrl('public/images/logo.png', 'image/png'),
        montserrat(700, title),
        montserrat(600, subtitle + new URL(SITE.url).host),
    ])

    return new ImageResponse(
        (
            <div style={{ position: 'relative', display: 'flex', width: '100%', height: '100%', backgroundColor: SITE.colour, color: 'white', fontFamily: 'Montserrat' }}>
                {/* The scene, and a soft darkening behind the text so it reads at thumbnail size */}
                {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
                <img src={backdrop} width={1200} height={675} style={{ position: 'absolute', top: -20, left: 0 }} />
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', background: 'radial-gradient(ellipse 70% 55% at 50% 44%, rgba(11,16,31,0.55), rgba(11,16,31,0) 100%)' }} />

                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 60 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={logo} width={120} height={120} alt="" />
                        <div style={{ fontSize: 112, fontWeight: 700, letterSpacing: 10, lineHeight: 1, textShadow: '0 4px 30px rgba(11,16,31,0.6)' }}>{title}</div>
                    </div>
                    <div style={{ marginTop: 26, fontSize: 28, fontWeight: 600, letterSpacing: 6, color: '#dbe6f7', textShadow: '0 2px 16px rgba(11,16,31,0.8)' }}>{subtitle}</div>
                </div>

                <div style={{ position: 'absolute', bottom: 34, left: 0, right: 0, display: 'flex', justifyContent: 'center', fontSize: 24, fontWeight: 600, letterSpacing: 4, color: 'rgba(191,230,251,0.75)' }}>
                    {new URL(SITE.url).host}
                </div>
            </div>
        ),
        { ...SHARE_SIZE, fonts: [bold, semibold].filter(f => f !== null) },
    )
}
