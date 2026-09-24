import { describe, expect, it } from 'vitest'

import {
    ENV_NAME, LIVE, RESERVED_ENVIRONMENT_NAMES, isEnvironmentName, newEnvironmentProblem,
} from './environmentName'
import * as env from './env'

describe('isEnvironmentName', () => {
    it('takes a lowercase name that starts with a letter, up to sixteen characters', () => {
        for (const name of ['live', 'test', 'uat1', 'staging', 'a', 'a'.repeat(16)]) {
            expect(isEnvironmentName(name), name).toBe(true)
        }
    })

    it('refuses a hyphen, a capital, a leading digit, a dot, an empty name and a long one', () => {
        for (const name of ['uat-1', 'Uat1', '1uat', '.deleted', '', 'a'.repeat(17), 'uat 1', 'uat_1']) {
            expect(isEnvironmentName(name), name).toBe(false)
        }
    })

    it('refuses every reserved name, which the layout or the api routes already use', () => {
        expect([...RESERVED_ENVIRONMENT_NAMES].sort()).toEqual(['backups', 'environments', 'git', 'next', 'prev'])
        for (const name of RESERVED_ENVIRONMENT_NAMES) expect(isEnvironmentName(name), name).toBe(false)
    })

    it('refuses something that is not a string at all, since it arrives from a browser', () => {
        for (const value of [null, undefined, 5, {}, ['live']]) expect(isEnvironmentName(value)).toBe(false)
    })

    it('matches the rule hostd uses', () => {
        expect(ENV_NAME.source).toBe('^[a-z][a-z0-9]{0,15}$')
        expect(LIVE).toBe('live')
    })
})

describe('newEnvironmentProblem', () => {
    it('has nothing to say about a name that can be added', () => {
        expect(newEnvironmentProblem('uat1')).toBeNull()
    })

    it('says live already exists on every site', () => {
        expect(newEnvironmentProblem('live')).toMatch(/every site has live/i)
    })

    it('says a reserved name is taken, naming it', () => {
        expect(newEnvironmentProblem('next')).toMatch(/next is reserved/i)
    })

    it('says what the rule is for anything else', () => {
        expect(newEnvironmentProblem('uat-1')).toMatch(/lowercase letters and digits/i)
        expect(newEnvironmentProblem('')).toMatch(/lowercase letters and digits/i)
    })
})

describe('env.ts', () => {
    it('hands on the same rule, so there is one of it', () => {
        expect(env.ENV_NAME).toBe(ENV_NAME)
        expect(env.isEnvironmentName).toBe(isEnvironmentName)
        expect(env.RESERVED_ENVIRONMENT_NAMES).toBe(RESERVED_ENVIRONMENT_NAMES)
    })
})
