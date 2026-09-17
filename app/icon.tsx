import { renderAppIcon } from './appIcon'

export const size = { width: 512, height: 512 }
export const contentType = 'image/png'
export const dynamic = 'force-static'

export default function Icon() {
    return renderAppIcon(size.width, true)
}
