import { cleanup, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { getProject } from '@/app/showcase/projects'

import ProjectPage, { generateMetadata, generateStaticParams } from './page'

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND') } }))

const page = async (slug: string) => render(await ProjectPage({ params: Promise.resolve({ slug }) }))

describe('a project page', () => {
    it('renders a page for every project', async () => {
        for (const { slug } of generateStaticParams()) {
            await page(slug)
            expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(getProject(slug)!.name)
            cleanup()
        }
    })

    it('404s an unknown slug', async () => {
        await expect(ProjectPage({ params: Promise.resolve({ slug: 'nope' }) })).rejects.toThrow('NEXT_NOT_FOUND')
    })


    it('shows the video in place of the gallery when a project has one', async () => {
        await page('ai-culler')
        expect(screen.getByRole('button', { name: 'Play video: AIC | Engagement Performance Test' })).toBeInTheDocument()
        expect(screen.queryByTestId('cover-placeholder')).not.toBeInTheDocument()
        expect(screen.getByRole('link', { name: /YouTube/ })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=Gz_TsMQTI4g')
    })

    it('links both versions of the PMPC site I built, the original first and standing out', async () => {
        await page('pmpc-group')
        const original = screen.getByRole('link', { name: /View the original/ })
        const redesign = screen.getByRole('link', { name: /View the redesign/ })
        expect(original).toHaveAttribute('href', 'https://pmpcold.horizons.gg/')
        expect(redesign).toHaveAttribute('href', 'https://pmpcgroup.horizons.gg/')
        expect(original.compareDocumentPosition(redesign) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(original).toHaveAttribute('data-primary')
        expect(redesign).not.toHaveAttribute('data-primary')
    })

    it('links back to the projects section', async () => {
        await page('voxweave')
        expect(screen.getByRole('link', { name: /Back to projects/ })).toHaveAttribute('href', '/#projects')
    })

    it('shows a store without a link as coming soon', async () => {
        await page('blastyard')
        expect(screen.getByText(/Steam/).closest('[aria-disabled="true"]')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /Game website/ })).toHaveAttribute('href', '/blastyard')
    })

    it('sets the canonical and description', async () => {
        const m = await generateMetadata({ params: Promise.resolve({ slug: 'voxweave' }) })
        expect(m.alternates?.canonical).toBe('/projects/voxweave')
        expect(m.description).toBe(getProject('voxweave')!.summary)
    })

    it('gives a shared link its own card', async () => {
        const m = await generateMetadata({ params: Promise.resolve({ slug: 'voxweave' }) })
        const og = m.openGraph as { url?: string, title?: string, siteName?: string, images?: { url: string }[] }
        expect(og.url).toBe('/projects/voxweave')
        expect(og.title).toBe('Voxweave')
        expect(og.siteName).toBe('Horizons')
        expect(og.images?.[0].url).toBe(getProject('voxweave')!.screenshots[0].src)
        const tw = m.twitter as { title?: string, card?: string, images?: string[] }
        expect(tw.title).toBe('Voxweave')
        expect(tw.card).toBe('summary_large_image')
    })

    it("shares AI Culler with its video's thumbnail", async () => {
        const m = await generateMetadata({ params: Promise.resolve({ slug: 'ai-culler' }) })
        const og = m.openGraph as { title?: string, images?: { url: string }[] }
        expect(og.title).toBe('AI Culler')
        expect(og.images?.[0].url).toBe('/projects/ai-culler/01.webp')
    })

    it('has one full-width "Built with" panel, with no separate "How it was built"', async () => {
        await page('voxweave')
        expect(screen.getByRole('heading', { name: 'Built with' })).toBeInTheDocument()
        expect(screen.queryByRole('heading', { name: 'How it was built' })).not.toBeInTheDocument()
    })

    it('credits Claude in the corner of "Built with" for a project built with it', async () => {
        await page('voxweave')
        const mark = screen.getByTestId('claude-mark')
        expect(mark).toHaveTextContent('Assisted by Claude')
        expect(mark.querySelector('svg')).toBeInTheDocument()
        expect(mark.closest('section, div')).toContainElement(screen.getByRole('heading', { name: 'Built with' }).parentElement!.querySelector('[data-testid="claude-mark"]'))
    })

    it("uses a part hand-written project's own note as its credit", async () => {
        await page('asot-milsim')
        expect(screen.getByTestId('claude-mark')).toHaveTextContent('By hand from 2024, with Claude since late 2025')
    })

    it('gives a project written by hand no Claude credit', async () => {
        await page('tax-assistant')
        expect(screen.queryByTestId('claude-mark')).not.toBeInTheDocument()
    })
})
