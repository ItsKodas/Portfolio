import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { ALL_PERMISSIONS, PERMISSIONS, PERMISSION_LABELS, parsePermissions } from './permissions'

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

    it('starts a grant with all of them, which is what every link from before was carried across with', () => {
        expect(ALL_PERMISSIONS).toEqual(PERMISSIONS)
        const migration = readFileSync(new URL('../../prisma/migrations/20261009120000_site_access/migration.sql', import.meta.url), 'utf8')
        expect(migration).toContain(`ARRAY[${PERMISSIONS.map(p => `'${p}'`).join(', ')}]::"SitePermission"[]`)
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
})
