import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS, PERMISSIONS, PERMISSION_LABELS, parsePermissions } from './permissions'

describe('permissions', () => {
    // The schema's enum is what Postgres holds and this list is what the forms and checks use: they must be
    // one list, in one order.
    it('matches the SitePermission enum in prisma/schema.prisma', () => {
        const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')
        const body = schema.match(/enum SitePermission \{([^}]*)\}/)?.[1] ?? ''
        const values = body.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('//'))
        expect(values).toEqual([...PERMISSIONS])
    })

    it('labels every permission', () => {
        expect(Object.keys(PERMISSION_LABELS).sort()).toEqual([...PERMISSIONS].sort())
    })

    it('gives the operator all of them, and starts a new grant with all but the env files', () => {
        expect(ALL_PERMISSIONS).toEqual(PERMISSIONS)
        expect(DEFAULT_PERMISSIONS).toEqual(['LOGS', 'LIFECYCLE', 'ENVIRONMENTS', 'DEPLOYS', 'BACKUPS'])
    })

    // Every link from before site access was carried across with what a client could do then, which was the
    // first four. BACKUPS came later and is added to the enum alone: a grant made before it never gains a
    // way to download a site's database without the operator ticking it.
    it('carries old links across with the four that existed, and gives BACKUPS to nobody by itself', () => {
        const read = (name: string) => readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8')
        expect(read('20261009120000_site_access')).toContain(`ARRAY['LOGS', 'LIFECYCLE', 'ENVIRONMENTS', 'DEPLOYS']::"SitePermission"[]`)
        const backups = read('20261010040000_backups_permission')
        expect(backups).toContain(`ALTER TYPE "SitePermission" ADD VALUE 'BACKUPS'`)
        expect(backups).not.toMatch(/UPDATE|INSERT/i)
    })

    // Viewing environments stays viewing: no grant that has ENVIRONMENTS gains the env files with it
    it('gives ENV_FILES to nobody by itself', () => {
        const read = (name: string) => readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8')
        const envFiles = read('20261010080000_env_files_permission')
        expect(envFiles).toContain(`ALTER TYPE "SitePermission" ADD VALUE 'ENV_FILES'`)
        expect(envFiles).not.toMatch(/UPDATE|INSERT/i)
    })

    // Using the Backups tab stays making and downloading copies: nobody gains restoring with it
    it('gives RESTORE_BACKUPS to nobody by itself, new grants included', () => {
        const read = (name: string) => readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8')
        const restore = read('20261010140000_restore_backups_permission')
        expect(restore).toContain(`ALTER TYPE "SitePermission" ADD VALUE 'RESTORE_BACKUPS'`)
        expect(restore).not.toMatch(/UPDATE|INSERT/i)
        expect(DEFAULT_PERMISSIONS).not.toContain('RESTORE_BACKUPS')
    })
})

describe('parsePermissions', () => {
    it('answers a list in the one order, without repeats', () => {
        expect(parsePermissions(['DEPLOYS', 'LOGS', 'LOGS'])).toEqual(['LOGS', 'DEPLOYS'])
        expect(parsePermissions([])).toEqual([])
    })

    it('refuses anything that is not a list of known permissions, whole', () => {
        for (const input of [null, 'LOGS', ['LOGS', 'ADMIN'], [1], { 0: 'LOGS' }]) {
            expect(parsePermissions(input)).toBeNull()
        }
    })

    it('refuses the env files without the Environments tab they live in', () => {
        expect(parsePermissions(['ENV_FILES'])).toBeNull()
        expect(parsePermissions(['ENV_FILES', 'ENVIRONMENTS'])).toEqual(['ENVIRONMENTS', 'ENV_FILES'])
    })

    it('refuses restoring without the Backups tab it is done from', () => {
        expect(parsePermissions(['RESTORE_BACKUPS'])).toBeNull()
        expect(parsePermissions(['RESTORE_BACKUPS', 'BACKUPS'])).toEqual(['BACKUPS', 'RESTORE_BACKUPS'])
    })
})
