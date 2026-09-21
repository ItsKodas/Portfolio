import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import * as icons from './index'

const EXPECTED = [
    'AcUnit', 'Add', 'ArrowBack', 'ArrowForward', 'Casino', 'Close', 'Cloud', 'ContentCopy', 'Dehaze',
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
})
