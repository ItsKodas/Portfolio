import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'

import { SITE } from './site'

// The white logo on the scene's navy, for home screens, the web app manifest and search results (see icon.tsx and
// apple-icon.tsx). Made once, at build time.
export async function renderAppIcon(size: number, rounded: boolean) {
    const logo = `data:image/png;base64,${(await readFile(join(process.cwd(), 'public/images/logo.png'))).toString('base64')}`
    return new ImageResponse(
        (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', background: `linear-gradient(160deg, #27336b, ${SITE.colour})`, borderRadius: rounded ? size * 0.22 : 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logo} width={size * 0.64} height={size * 0.64} alt="" />
            </div>
        ),
        { width: size, height: size },
    )
}
