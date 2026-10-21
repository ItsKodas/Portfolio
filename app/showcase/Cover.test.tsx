import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Cover } from './Cover'
import { getProject } from './projects'

describe('Cover', () => {
    it('shows the first desktop screenshot as the cover', () => {
        const project = getProject('atomic-sandbox')!
        render(<div className="relative"><Cover project={project} sizes="50vw" /></div>)
        expect(screen.getByRole('img')).toHaveAttribute('alt', project.screenshots[0].alt)
    })

    it('shows a placeholder with the logo when there are no screenshots', () => {
        render(<div className="relative"><Cover project={getProject('ai-culler')!} sizes="50vw" /></div>)
        expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument()
        expect(screen.getByRole('img', { name: 'AI Culler logo' })).toBeInTheDocument()
        expect(screen.getByText('Screenshots coming soon')).toBeInTheDocument()
    })
})
