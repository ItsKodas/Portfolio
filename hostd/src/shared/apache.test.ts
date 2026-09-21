import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseApacheResult } from './apache.ts'

describe('parseApacheResult', () => {
    it('reads a result the host unit wrote', () => {
        assert.deepEqual(
            parseApacheResult('{"seq":7,"ok":true,"output":"Syntax OK"}'),
            { seq: 7, ok: true, output: 'Syntax OK' },
        )
    })

    it('reads a failure with Apache\'s own output', () => {
        const result = parseApacheResult('{"seq":8,"ok":false,"output":"AH00526: Syntax error on line 4"}')
        assert.equal(result?.ok, false)
        assert.match(result?.output ?? '', /AH00526/)
    })

    it('returns null for anything malformed, rather than guessing', () => {
        for (const bad of ['', 'not json', '{}', '{"seq":"7","ok":true,"output":""}', '{"seq":7,"ok":1,"output":""}', '[]']) {
            assert.equal(parseApacheResult(bad), null, bad)
        }
    })

    it('returns null for a negative or fractional sequence', () => {
        assert.equal(parseApacheResult('{"seq":-1,"ok":true,"output":""}'), null)
        assert.equal(parseApacheResult('{"seq":1.5,"ok":true,"output":""}'), null)
    })

    it('tolerates a result being written while it is read, by failing rather than throwing', () => {
        assert.equal(parseApacheResult('{"seq":7,"ok":tr'), null)
    })
})
