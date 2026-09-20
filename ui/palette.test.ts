// Every colour in a component stylesheet must come from a token. The grep that was supposed to enforce
// that looked for hex, so three chip borders written as decimal rgba() of the old palette sailed past it
// and survived a retint, leaving every chip ringed in the previous scheme. This is that check done
// properly, and it runs.
//
// Neutral overlays are allowed, because rgba(255,255,255,.025) is an operation on whatever is underneath
// rather than a colour of its own: it stays correct through any retint. A tint with a hue is a copy of a
// token's value frozen in place, which does not.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('.', import.meta.url))

function stylesheets(dir: string): string[] {
    return readdirSync(dir).flatMap(entry => {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) return stylesheets(path)
        return entry.endsWith('.module.css') ? [path] : []
    })
}

// A literal colour: hex in any length, or an rgb/rgba whose channels are not all equal.
function literals(css: string): string[] {
    const found: string[] = []

    for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) found.push(match[0])

    for (const match of css.matchAll(/rgba?\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)/g)) {
        const [r, g, b] = [match[1], match[2], match[3]].map(Number)
        if (r !== g || g !== b) found.push(match[0] + ')')
    }

    return found
}

describe('the component stylesheets', () => {
    const files = stylesheets(root)

    it('finds some stylesheets to check, so a silent pass means something', () => {
        expect(files.length).toBeGreaterThan(5)
    })

    it.each(files.map(f => [f.slice(root.length).replace(/\\/g, '/'), f]))(
        '%s writes no colour of its own',
        (_name, path) => {
            const found = literals(readFileSync(path, 'utf8'))
            expect(found, `use a token, or color-mix on one, instead of ${found.join(', ')}`).toEqual([])
        },
    )

    it('allows a neutral overlay, which survives a retint', () => {
        expect(literals('.a { background: rgba(255, 255, 255, .025); }')).toEqual([])
        expect(literals('.a { background: rgba(0, 0, 0, .4); }')).toEqual([])
    })

    it('catches a tinted one, which does not', () => {
        expect(literals('.a { border-color: rgba(111, 211, 155, .35); }')).toEqual(['rgba(111, 211, 155)'])
        expect(literals('.a { color: #8fd4f5; }')).toEqual(['#8fd4f5'])
    })
})
