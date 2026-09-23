import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import * as icons from './index'

const EXPECTED = [
    'AcUnit', 'Add', 'ArrowBack', 'ArrowForward', 'Casino', 'Close', 'Cloud', 'ContentCopy', 'Dashboard', 'Dehaze',
    'DeleteOutline', 'FilterDrama', 'GitHub', 'Grain', 'Instagram', 'Language', 'LinkedIn', 'MusicNote',
    'NightsStay', 'NorthEast', 'Pause', 'Place', 'SportsEsports', 'Thunderstorm', 'WarningAmber', 'WaterDrop',
    'WbSunny', 'YouTube',
]

describe('the icons', () => {
    it('replaces every one the app imports from MUI', () => {
        expect(Object.keys(icons).sort()).toEqual([...EXPECTED].sort())
    })

    it('are decorative by default, so they are not read out beside their own label', () => {
        const { container } = render(<icons.Close />)
        expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    })

    it('become an image with a name when given a title', () => {
        const { container } = render(<icons.Close title="Close" />)
        const svg = container.querySelector('svg')
        expect(svg).not.toHaveAttribute('aria-hidden')
        expect(svg).toHaveAttribute('role', 'img')
        expect(svg).toHaveAccessibleName('Close')
    })

    it('take their colour from the text around them', () => {
        const { container } = render(<icons.Close />)
        expect(container.querySelector('svg')).toHaveAttribute('fill', 'currentColor')
    })

    // The landing page hangs its hover transitions off the icon itself, which is what MUI's className did
    it('pass a class name through, so a page can animate one', () => {
        const { container } = render(<icons.NorthEast className="group-hover:translate-x-1" />)
        expect(container.querySelector('svg')).toHaveClass('group-hover:translate-x-1')
    })

    // Not a detail. The wallpaper sizes five of its icons with `font-size: ... !important` and nothing else,
    // which worked because MUI's SvgIcon was 1em square. A width in pixels here would ignore all five and
    // break the wallpaper quietly, since nothing else exercises that page.
    it('are an em square, so a stylesheet can still size one by its font size', () => {
        const { container } = render(<icons.Place />)
        const svg = container.querySelector('svg')
        expect(svg).toHaveAttribute('width', '1em')
        expect(svg).toHaveAttribute('height', '1em')
    })

    it('carry the size prop as the font size the em is measured against', () => {
        const { container } = render(<icons.Place size={28} />)
        expect(container.querySelector('svg')).toHaveStyle({ fontSize: '28px' })
    })
})
