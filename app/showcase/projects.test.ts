import { describe, expect, it } from 'vitest'

import {
    PROJECTS, builtLine, categoriesInUse, featured, getProject, inCategory, listed, monogram, neighbours, yearsLabel,
} from './projects'

// Every string a project holds, wherever it sits, so the copy rules below can't be dodged by nesting
function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(strings)
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
    return []
}

// Words that make copy read as written by a machine (see the spec's anti-goals)
const BANNED = ['seamless', 'robust', 'leverage', 'cutting-edge', 'passionate', 'innovative', 'elevate', 'empower',
    'state-of-the-art', 'delve', 'world-class']

describe('the projects', () => {
    it('has exactly the 12 projects', () => {
        expect(PROJECTS.map(p => p.name).sort()).toEqual(["AI Culler", "ASOT Milsim", "Arby's Auto Glass", 'Atomic Sandbox',
            'Blastyard', 'Horizons Portfolio', 'PMPC Group', 'Spot On Drones', 'Tax Assistant', 'The Back Room', 'Voxweave',
            '1st CANZUK Brigade'].sort())
    })

    it('features PMPC, Spot On Drones, Atomic Sandbox and ASOT in that order', () => {
        expect(featured().map(p => p.slug)).toEqual(['pmpc-group', 'spot-on-drones', 'atomic-sandbox', 'asot-milsim'])
    })

    it('has unique slugs of lowercase words joined by hyphens', () => {
        const slugs = PROJECTS.map(p => p.slug)
        expect(new Set(slugs).size).toBe(slugs.length)
        for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    })

    it('lists the rest newest first without the featured', () => {
        const rest = listed()
        expect(rest).toHaveLength(8)
        expect(rest.some(p => p.featured)).toBe(false)
        for (let i = 1; i < rest.length; i++) expect(rest[i].years[1]).toBeLessThanOrEqual(rest[i - 1].years[1])
    })

    it('includes featured projects in a category view', () => {
        expect(inCategory('desktop-app').map(p => p.slug)).toEqual(expect.arrayContaining(['atomic-sandbox', 'voxweave']))
        expect(inCategory('desktop-app')).toHaveLength(2)
    })

    it('only offers categories that have a project', () => {
        expect(categoriesInUse()).toEqual(['website', 'web-app', 'desktop-app', 'mobile-app', 'game', 'mod'])
    })

    it('says how each project was built', () => {
        expect(builtLine(getProject('tax-assistant')!)).toBe('Written by hand')
        expect(builtLine(getProject('voxweave')!)).toBe('Built with Claude, designed and directed by me')
        expect(builtLine(getProject('asot-milsim')!)).toBe('By hand from 2024, with Claude since late 2025')
    })

    it('gives every "both" project its own note', () => {
        for (const p of PROJECTS.filter(p => p.built === 'both')) expect(p.builtNote).toBeTruthy()
    })

    it('labels years', () => {
        expect(yearsLabel(getProject('voxweave')!)).toBe('2026')
        expect(yearsLabel(getProject('asot-milsim')!)).toBe('2024 to 2026')
    })

    it('makes monograms', () => {
        expect(monogram('Atomic Sandbox')).toBe('AS')
        expect(monogram('Voxweave')).toBe('V')
        expect(monogram('1st CANZUK Brigade')).toBe('1C')
    })

    it('wraps around for neighbours', () => {
        expect(neighbours('pmpc-group').previous?.slug).toBe(listed().at(-1)!.slug)
        expect(neighbours('pmpc-group').next?.slug).toBe('spot-on-drones')
        expect(neighbours(listed().at(-1)!.slug).next?.slug).toBe('pmpc-group')
    })

    it('only links over https', () => {
        for (const p of PROJECTS) {
            const { gameSite, websiteLabel, stores, ...rest } = p.links
            for (const href of [...Object.values(rest), ...(stores ?? []).map(s => s.href)].filter(Boolean)) {
                expect(href).toMatch(/^https:\/\//)
            }
            if (gameSite) expect(gameSite).toMatch(/^\//)
        }
    })

    it('uses no em dash and no banned word in any string', () => {
        for (const p of PROJECTS) {
            for (const s of strings(p)) {
                expect(s, `${p.slug}: ${s}`).not.toContain('—')
                for (const word of BANNED) expect(s, `${p.slug}: ${s}`).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'))
            }
        }
    })
})
