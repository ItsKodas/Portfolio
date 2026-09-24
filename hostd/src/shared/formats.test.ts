import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    PROJECT_ID, CLIENT_ID, SERVICE_NAME, USER_ID, RESERVED_PROJECT_IDS, ENV_NAME, ENV_VAR_NAME, RESERVED_ENVIRONMENT_NAMES,
    isEnvironmentName, isRecord, relativePathProblem, isWithin, overlaps, describeError,
} from './formats.ts'

describe('identifier patterns', () => {
    it('accepts any short lowercase environment name, not only live and test', () => {
        for (const name of ['live', 'test', 'uat1', 'staging', 'a', 'a'.repeat(16)]) {
            assert.equal(isEnvironmentName(name), true, name)
            assert.ok(ENV_NAME.test(name), name)
        }
    })

    it('refuses reserved, hyphenated, uppercase, overlong and non-string environment names', () => {
        for (const name of ['git', 'next', 'prev', 'uat-1', 'Uat1', 'UAT', '1uat', '', 'a'.repeat(17), 'uat_1', 'uat.1', '__proto__']) {
            assert.equal(isEnvironmentName(name), false, name)
        }
        for (const value of [null, undefined, 1, ['live'], { name: 'live' }]) assert.equal(isEnvironmentName(value), false)
    })

    it('reserves exactly the folders of the nested layout', () => {
        assert.deepEqual([...RESERVED_ENVIRONMENT_NAMES].sort(), ['git', 'next', 'prev'])
    })

    it('keeps environment variable names a separate grammar', () => {
        assert.ok(ENV_VAR_NAME.test('WEB_PORT'))
        assert.equal(ENV_VAR_NAME.test('live'), false)
    })

    it('accepts the project ids the registry uses', () => {
        assert.ok(PROJECT_ID.test('acme-bakery'))
        assert.ok(PROJECT_ID.test('a1'))
    })

    it('refuses project ids that could not be compose project names or are too short', () => {
        for (const id of ['A-bakery', '-acme', 'a', 'acme_bakery', 'a'.repeat(32), '__proto__']) {
            assert.equal(PROJECT_ID.test(id), false, id)
        }
    })

    it('reserves the operator\'s own stacks', () => {
        assert.deepEqual([...RESERVED_PROJECT_IDS].sort(), ['horizons', 'hostd', 'mail'])
    })

    it('accepts portal client ids and refuses anything with a separator', () => {
        assert.ok(CLIENT_ID.test('cl_8f2k1'))
        assert.equal(CLIENT_ID.test('cl:1'), false)
        assert.equal(CLIENT_ID.test(''), false)
    })

    it('accepts compose service names', () => {
        assert.ok(SERVICE_NAME.test('web'))
        assert.ok(SERVICE_NAME.test('db_1.primary'))
        assert.equal(SERVICE_NAME.test('-web'), false)
        assert.equal(SERVICE_NAME.test('web/other'), false)
    })

    it('accepts portal user ids and refuses whitespace', () => {
        assert.ok(USER_ID.test('user:abc@example.com'))
        assert.equal(USER_ID.test('a b'), false)
    })
})

describe('isRecord', () => {
    it('is true only for plain object-like values', () => {
        assert.equal(isRecord({}), true)
        assert.equal(isRecord([]), false)
        assert.equal(isRecord(null), false)
        assert.equal(isRecord('x'), false)
    })
})

describe('relativePathProblem', () => {
    it('accepts ordinary relative paths', () => {
        assert.equal(relativePathProblem('uploads'), null)
        assert.equal(relativePathProblem('uploads/2026/photo one.jpg'), null)
    })

    const refused: Array<[string, string]> = [
        ['', 'path is empty'],
        ['/etc/passwd', 'path must be relative'],
        ['uploads/../../etc', 'path contains ..'],
        ['..', 'path contains ..'],
        ['./uploads', 'path contains .'],
        ['uploads//x', 'path contains an empty segment'],
        ['uploads/', 'path contains an empty segment'],
        ['uploads\\x', 'path contains a backslash'],
        ['up\u0000loads', 'path contains a control character'],
        ['up\nloads', 'path contains a control character'],
        ['a'.repeat(256), 'a path segment is longer than 255 bytes'],
        [('a'.repeat(200) + '/').repeat(21) + 'a', 'path is longer than 4096 bytes'],
    ]
    for (const [path, reason] of refused) {
        it(`refuses ${JSON.stringify(path.slice(0, 30))}`, () => {
            assert.equal(relativePathProblem(path), reason)
        })
    }

    it('counts bytes, not characters, against the segment limit', () => {
        // 128 two-byte characters is 256 bytes.
        assert.equal(relativePathProblem('é'.repeat(128)), 'a path segment is longer than 255 bytes')
    })
})

describe('isWithin and overlaps', () => {
    it('treats a path as within itself and its ancestors', () => {
        assert.equal(isWithin('/var/www/a', '/var/www/a'), true)
        assert.equal(isWithin('/var/www/a', '/var/www/a/uploads/x'), true)
    })

    it('does not confuse a shared prefix with containment', () => {
        assert.equal(isWithin('/var/www/a', '/var/www/ab'), false)
    })

    it('overlaps in either direction', () => {
        assert.equal(overlaps('/var/www/a/uploads', '/var/www/a'), true)
        assert.equal(overlaps('/var/www/a', '/var/www/a/uploads'), true)
        assert.equal(overlaps('/var/www/a/uploads', '/var/www/a/db'), false)
    })
})

describe('describeError', () => {
    it('uses the message of an Error and stringifies anything else', () => {
        assert.equal(describeError(new Error('boom')), 'boom')
        assert.equal(describeError('plain'), 'plain')
    })
})
