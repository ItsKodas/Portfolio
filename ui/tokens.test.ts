import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TOKENS } from './tokens'

const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

function propertiesIn(source: string): Record<string, string> {
    const found: Record<string, string> = {}
    for (const line of source.split('\n')) {
        const match = line.match(/^\s*--([a-z0-9-]+):\s*(.+?);/)
        if (match) found[match[1]] = match[2].trim()
    }
    return found
}

describe('the tokens', () => {
    it('are the same list in the stylesheet and in TypeScript', () => {
        // Two readers, one list. A colour added to one and missed in the other is the bug this catches.
        expect(propertiesIn(css)).toEqual(TOKENS)
    })

    it('keep the surfaces belonging to the scene, which are tuned to the artwork', () => {
        expect(TOKENS['scene-bg']).toBe('#101727')
        expect(TOKENS['scene-paper']).toBe('#0b0d1c')
        expect(TOKENS['night']).toBe('#0b101f')
    })

    it('has no colour written twice under different names', () => {
        const colours = Object.entries(TOKENS).filter(([, value]) => value.startsWith('#'))
        const seen = new Map<string, string>()
        for (const [name, value] of colours) {
            const already = seen.get(value)
            expect(already, `${name} repeats ${already}`).toBeUndefined()
            seen.set(value, name)
        }
    })
})
