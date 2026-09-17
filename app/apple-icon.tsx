import { renderAppIcon } from './appIcon'

// (square: iOS rounds the corners itself)
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'
export const dynamic = 'force-static'

export default function AppleIcon() {
    return renderAppIcon(size.width, false)
}
