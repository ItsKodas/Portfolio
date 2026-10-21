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

    it('says how it was built', async () => {
        await page('asot-milsim')
        expect(screen.getByText('By hand from 2024, with Claude since late 2025')).toBeInTheDocument()
    })

    it('shows the placeholder for a project without screenshots', async () => {
        await page('ai-culler')
        expect(screen.getByTestId('cover-placeholder')).toBeInTheDocument()
    })

    it('labels PMPC as my build', async () => {
        await page('pmpc-group')
        expect(screen.getByRole('link', { name: /View my build/ })).toHaveAttribute('href', 'https://pmpcgroup.horizons.gg/')
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

    it("falls back to the site's share image for a project without screenshots", async () => {
        const m = await generateMetadata({ params: Promise.resolve({ slug: 'ai-culler' }) })
        const og = m.openGraph as { title?: string, images?: { url: string }[] }
        expect(og.title).toBe('AI Culler')
        expect(og.images?.[0].url).toBe('/opengraph-image')
    })
})
