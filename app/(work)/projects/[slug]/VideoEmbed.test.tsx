import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { getProject } from '@/app/showcase/projects'

import { VideoEmbed } from './VideoEmbed'

describe('VideoEmbed', () => {
    const project = getProject('ai-culler')!

    it("loads nothing from YouTube until it's played", () => {
        const { container } = render(<VideoEmbed video={project.video!} poster={project.screenshots[0]} />)
        expect(container.querySelector('iframe')).toBeNull()
    })

    it('plays the video from the privacy-enhanced player when clicked', async () => {
        const { container } = render(<VideoEmbed video={project.video!} poster={project.screenshots[0]} />)
        await userEvent.click(screen.getByRole('button', { name: 'Play video: AIC | Engagement Performance Test' }))
        const frame = container.querySelector('iframe')!
        expect(frame.getAttribute('src')).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/Gz_TsMQTI4g\?/)
        expect(frame).toHaveAttribute('title', 'AIC | Engagement Performance Test')
    })
})
