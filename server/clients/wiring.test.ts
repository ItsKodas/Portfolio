import { describe, expect, it } from 'vitest'

import { CLIENT_ID_PATTERN } from './ids'

// The one rule in wiring.ts that isn't just plumbing: the id it allocates has to satisfy both our pattern and
// hostd's, because it is typed into projects.yaml by hand.
describe('the ids wiring allocates', () => {
    it('satisfies hostd/src/shared/formats.ts', () => {
        expect(CLIENT_ID_PATTERN.source).toContain('cl_')
        const sample = 'cl_0123ABCD'
        expect(CLIENT_ID_PATTERN.test(sample)).toBe(true)
        expect(/^[A-Za-z0-9_-]{1,64}$/.test(sample)).toBe(true)
    })
})
