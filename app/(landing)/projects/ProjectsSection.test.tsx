import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { featured } from '@/app/showcase/projects'

import { scrollToContent } from '../parallax/content'
import ProjectsSection from './ProjectsSection'

vi.mock('../parallax/content', () => ({ scrollToContent: vi.fn() }))

afterEach(() => {
    window.location.hash = ''
    vi.mocked(scrollToContent).mockClear()
})

describe('ProjectsSection', () => {
    it('shows the four featured cards and the other eight as rows by default', () => {
        render(<ProjectsSection />)
        expect(screen.getAllByTestId('featured-card')).toHaveLength(4)
        expect(screen.getAllByTestId('project-row')).toHaveLength(8)
    })

    it('offers only categories with a project, All first', () => {
        render(<ProjectsSection />)
        const group = screen.getByRole('group', { name: 'Filter projects' })
        expect(within(group).getAllByRole('button').map(b => b.textContent))
            .toEqual(['All', 'Websites', 'Web apps', 'Desktop apps', 'Mobile apps', 'Games', 'Mods'])
        expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('hides the featured block in a category and lists featured projects of that kind', async () => {
        render(<ProjectsSection />)
        await userEvent.click(screen.getByRole('button', { name: 'Desktop apps' }))
        expect(screen.queryAllByTestId('featured-card')).toHaveLength(0)
        expect(screen.getAllByTestId('project-row').map(r => r.getAttribute('href')))
            .toEqual(['/projects/atomic-sandbox', '/projects/voxweave'])
        expect(screen.getByRole('button', { name: 'Desktop apps' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('links every card to its project page', () => {
        render(<ProjectsSection />)
        expect(screen.getAllByTestId('featured-card').map(c => c.getAttribute('href')))
            .toEqual(featured().map(p => `/projects/${p.slug}`))
    })

    it('glides to the section when the page opens on #projects', async () => {
        window.location.hash = '#projects'
        Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: window.innerHeight * 4 })
        const { container } = render(<ProjectsSection />)
        await waitFor(() => expect(scrollToContent).toHaveBeenCalledWith(container.firstElementChild, 48, 'auto'))
    })
})
