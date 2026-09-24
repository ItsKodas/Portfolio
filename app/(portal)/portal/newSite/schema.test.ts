import { describe, expect, it } from 'vitest'

import { newSiteSchema } from './schema'

// Only the compose rule is under test here; the other fields are whatever parses
const compose = (list: string[]) => newSiteSchema.shape.compose.safeParse(list)

describe('the compose list', () => {
    it('leaves room for the file hostd writes', () => {
        expect(compose(Array.from({ length: 7 }, (_, index) => `c${index}.yml`)).success).toBe(true)
        const eight = compose(Array.from({ length: 8 }, (_, index) => `c${index}.yml`))
        expect(eight.success).toBe(false)
        expect(eight.error?.issues[0]?.message).toBe('List at most 7 compose files.')
    })

    it('refuses the name hostd writes, in any folder', () => {
        const result = compose(['docker-compose.yml', 'deploy/hostd.ports.yml'])
        expect(result.success).toBe(false)
        expect(result.error?.issues[0]?.message).toBe('hostd.ports.yml is the file hostd writes; name your own compose files.')
    })
})
