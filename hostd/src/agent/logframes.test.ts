import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FrameDecoder, createLogDecoder, MAX_LINE_BYTES, MAX_FRAME_BYTES } from './logframes.ts'

function frame(type: number, text: string | Buffer): Buffer {
    const payload = typeof text === 'string' ? Buffer.from(text) : text
    const header = Buffer.alloc(8)
    header[0] = type
    header.writeUInt32BE(payload.length, 4)
    return Buffer.concat([header, payload])
}

const TS = '2026-09-20T01:02:03.123456789Z'

describe('FrameDecoder', () => {
    it('decodes one frame', () => {
        const frames = new FrameDecoder().push(frame(1, 'hello\n'))
        assert.deepEqual(frames.map(f => [f.stream, f.data.toString()]), [['stdout', 'hello\n']])
    })

    it('decodes several frames in one chunk, keeping stdout and stderr apart', () => {
        const frames = new FrameDecoder().push(Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]))
        assert.deepEqual(frames.map(f => [f.stream, f.data.toString()]), [['stdout', 'out\n'], ['stderr', 'err\n']])
    })

    it('waits for a frame split across chunks, including a split header', () => {
        const whole = frame(2, 'split frame\n')
        const decoder = new FrameDecoder()
        assert.deepEqual(decoder.push(whole.subarray(0, 5)), [])
        assert.deepEqual(decoder.push(whole.subarray(5, 12)), [])
        const frames = decoder.push(whole.subarray(12))
        assert.deepEqual(frames.map(f => [f.stream, f.data.toString()]), [['stderr', 'split frame\n']])
    })

    it('ignores stdin frames', () => {
        assert.deepEqual(new FrameDecoder().push(frame(0, 'typed\n')), [])
    })

    it('refuses a frame length no log line could have', () => {
        const header = Buffer.alloc(8)
        header[0] = 1
        header.writeUInt32BE(MAX_FRAME_BYTES + 1, 4)
        assert.throws(() => new FrameDecoder().push(header), /is larger than/)
    })
})

describe('createLogDecoder without a TTY', () => {
    it('splits timestamped lines into their parts', () => {
        const lines = createLogDecoder(false).push(frame(1, `${TS} GET / 200\n`))
        assert.deepEqual(lines, [{ stream: 'stdout', ts: TS, text: 'GET / 200', truncated: false }])
    })

    it('joins a line that spans frames', () => {
        const decoder = createLogDecoder(false)
        assert.deepEqual(decoder.push(frame(1, `${TS} first half `)), [])
        assert.deepEqual(decoder.push(frame(1, 'second half\n')), [{ stream: 'stdout', ts: TS, text: 'first half second half', truncated: false }])
    })

    it('keeps partial lines of each stream separate', () => {
        const decoder = createLogDecoder(false)
        const lines = decoder.push(Buffer.concat([frame(1, `${TS} out `), frame(2, `${TS} err\n`), frame(1, 'done\n')]))
        assert.deepEqual(lines.map(l => [l.stream, l.text]), [['stderr', 'err'], ['stdout', 'out done']])
    })

    it('strips a carriage return', () => {
        assert.equal(createLogDecoder(false).push(frame(1, `${TS} windows\r\n`))[0]?.text, 'windows')
    })

    it('caps a line at 16 KB, marks it truncated, and carries on normally', () => {
        const decoder = createLogDecoder(false, false)
        const lines = decoder.push(frame(1, `${'x'.repeat(MAX_LINE_BYTES + 100)}\nnext\n`))
        assert.equal(lines.length, 2)
        assert.equal(Buffer.byteLength(lines[0]?.text ?? ''), MAX_LINE_BYTES)
        assert.equal(lines[0]?.truncated, true)
        assert.deepEqual(lines[1], { stream: 'stdout', ts: null, text: 'next', truncated: false })
    })

    it('flushes a final line with no newline', () => {
        const decoder = createLogDecoder(false)
        decoder.push(frame(2, `${TS} last words`))
        assert.deepEqual(decoder.flush(), [{ stream: 'stderr', ts: TS, text: 'last words', truncated: false }])
    })

    it('flushes nothing when nothing is pending', () => {
        assert.deepEqual(createLogDecoder(false).flush(), [])
    })

    it('leaves text without a timestamp alone', () => {
        assert.deepEqual(createLogDecoder(false).push(frame(1, 'no stamp\n')), [{ stream: 'stdout', ts: null, text: 'no stamp', truncated: false }])
    })
})

describe('createLogDecoder with a TTY', () => {
    it('reads the stream raw, as stdout, with no frame headers', () => {
        const lines = createLogDecoder(true).push(Buffer.from(`${TS} interactive\n`))
        assert.deepEqual(lines, [{ stream: 'stdout', ts: TS, text: 'interactive', truncated: false }])
    })
})
