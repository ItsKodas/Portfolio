import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectLogo } from './ProjectLogo'
import { getProject } from './projects'

describe('ProjectLogo', () => {
    it("shows the project's logo, named for the project", () => {
        render(<ProjectLogo project={getProject('blastyard')!} size={40} />)
        expect(screen.getByRole('img', { name: 'Blastyard logo' })).toBeInTheDocument()
    })

    it('falls back to a monogram without a logo', () => {
        render(<ProjectLogo project={{ ...getProject('voxweave')!, logo: undefined }} size={40} />)
        expect(screen.getByText('V')).toBeInTheDocument()
        expect(screen.queryByRole('img')).not.toBeInTheDocument()
    })
})
