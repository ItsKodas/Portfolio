import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { featured } from '@/app/showcase/projects'

import { scrollToContent } from '../parallax/content'
import ProjectsSection from './ProjectsSection'

vi.mock('../parallax/content', () => ({ scrollToContent: vi.fn(), CONTENT_SPEED: 1 }))

afterEach(() => {
    window.location.hash = ''
    vi.mocked(scrollToContent).mockClear()
    vi.restoreAllMocks()
    delete (document.documentElement as { scrollHeight?: number }).scrollHeight
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

    it('shows a category as large cards under the tabs, featured projects of that kind included', async () => {
        render(<ProjectsSection />)
        await userEvent.click(screen.getByRole('button', { name: 'Desktop apps' }))
        expect(screen.queryAllByTestId('project-row')).toHaveLength(0)
        const cards = screen.getAllByTestId('featured-card')
        expect(cards.map(c => c.getAttribute('href'))).toEqual(['/projects/atomic-sandbox', '/projects/voxweave'])
        const tabs = screen.getByRole('group', { name: 'Filter projects' })
        for (const card of cards) expect(tabs.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Desktop apps' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('goes back to the featured cards and the list on All', async () => {
        render(<ProjectsSection />)
        await userEvent.click(screen.getByRole('button', { name: 'Games' }))
        await userEvent.click(screen.getByRole('button', { name: 'All' }))
        expect(screen.getAllByTestId('featured-card')).toHaveLength(4)
        expect(screen.getAllByTestId('project-row')).toHaveLength(8)
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

    // The featured cards sit above the tabs, so picking a kind shortens the page above them. Left alone the tabs would
    // jump up by that height twice over (the content rises twice as fast as the scroll); instead the page scrolls so
    // the tab strip stays where it was.
    it('keeps the tab strip where it was when a tab is picked', async () => {
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 2000 })
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
        render(<ProjectsSection />)
        const group = screen.getByRole('group', { name: 'Filter projects' })
        vi.spyOn(group, 'getBoundingClientRect')
            .mockReturnValueOnce({ top: 600 } as DOMRect)
            .mockReturnValueOnce({ top: -400 } as DOMRect)
        await userEvent.click(screen.getByRole('button', { name: 'Games' }))
        expect(scrollTo).toHaveBeenCalledWith(0, 1500)
        delete (window as { scrollY?: number }).scrollY
    })

    // Going back to All makes the page taller, but the page's height only catches up a moment later, so a single scroll
    // would be cut short at the old bottom; it keeps aiming for the same place for a few frames
    it('keeps aiming for the spot until the page has grown enough to reach it', async () => {
        let y = 1000
        Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y })
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(((_: number, top: number) => { y = Math.min(top, 1200) }) as typeof window.scrollTo)
        render(<ProjectsSection />)
        const group = screen.getByRole('group', { name: 'Filter projects' })
        vi.spyOn(group, 'getBoundingClientRect')
            .mockReturnValueOnce({ top: 300 } as DOMRect)
            .mockReturnValueOnce({ top: 1300 } as DOMRect)
        await userEvent.click(screen.getByRole('button', { name: 'Websites' }))
        expect(scrollTo).toHaveBeenLastCalledWith(0, 1500)
        scrollTo.mockImplementation(((_: number, top: number) => { y = top }) as typeof window.scrollTo)
        await new Promise(r => setTimeout(r, 100))
        expect(y).toBe(1500)
        delete (window as { scrollY?: number }).scrollY
    })
})
