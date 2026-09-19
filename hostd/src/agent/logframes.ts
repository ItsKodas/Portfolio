// Docker's log stream for a container without a TTY is multiplexed: each frame is an 8-byte header (the
// stream type, three zero bytes, a big-endian payload length) followed by the payload. Frames split
// lines at arbitrary points and socket chunks split frames at arbitrary points, so both layers buffer.

import type { LogLine } from '../shared/protocol.ts'

type StreamName = LogLine['stream']

export const MAX_LINE_BYTES = 16 * 1024
// No log frame is anywhere near this. A length this large means the bytes are not what we think they are,
// and buffering towards it would exhaust memory.
export const MAX_FRAME_BYTES = 16 * 1024 * 1024
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\S+) ([\s\S]*)$/

export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0)

    push(chunk: Buffer): Array<{ stream: StreamName, data: Buffer }> {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
        const frames: Array<{ stream: StreamName, data: Buffer }> = []
        while (this.buffer.length >= 8) {
            const type = this.buffer[0]
            const size = this.buffer.readUInt32BE(4)
            if (size > MAX_FRAME_BYTES) throw new Error(`log frame of ${size} bytes is larger than ${MAX_FRAME_BYTES}`)
            if (this.buffer.length < 8 + size) break
            const data = this.buffer.subarray(8, 8 + size)
            this.buffer = this.buffer.subarray(8 + size)
            if (type === 1) frames.push({ stream: 'stdout', data })
            else if (type === 2) frames.push({ stream: 'stderr', data })
        }
        return frames
    }
}

export class LineSplitter {
    private parts: Buffer[] = []
    private size = 0
    private truncated = false

    constructor(private readonly stream: StreamName, private readonly timestamps: boolean) {}

    push(data: Buffer): LogLine[] {
        const lines: LogLine[] = []
        let start = 0
        let newline = data.indexOf(0x0a, start)
        while (newline !== -1) {
            this.append(data.subarray(start, newline))
            lines.push(this.finish())
            start = newline + 1
            newline = data.indexOf(0x0a, start)
        }
        this.append(data.subarray(start))
        return lines
    }

    flush(): LogLine[] {
        return this.size > 0 || this.truncated ? [this.finish()] : []
    }

    private append(part: Buffer): void {
        const room = MAX_LINE_BYTES - this.size
        let kept = part
        if (kept.length > room) {
            this.truncated = true
            kept = kept.subarray(0, room)
        }
        if (kept.length > 0) {
            this.parts.push(kept)
            this.size += kept.length
        }
    }

    private finish(): LogLine {
        let text = Buffer.concat(this.parts).toString('utf8')
        if (text.endsWith('\r')) text = text.slice(0, -1)
        let ts: string | null = null
        if (this.timestamps) {
            const match = text.match(TIMESTAMP)
            if (match && match[1] !== undefined && match[2] !== undefined) {
                ts = match[1]
                text = match[2]
            }
        }
        const line: LogLine = { stream: this.stream, ts, text, truncated: this.truncated }
        this.parts = []
        this.size = 0
        this.truncated = false
        return line
    }
}

export type LogDecoder = { push(chunk: Buffer): LogLine[], flush(): LogLine[] }

export function createLogDecoder(tty: boolean, timestamps = true): LogDecoder {
    const stdout = new LineSplitter('stdout', timestamps)
    if (tty) return { push: chunk => stdout.push(chunk), flush: () => stdout.flush() }

    const stderr = new LineSplitter('stderr', timestamps)
    const frames = new FrameDecoder()
    return {
        push: chunk => frames.push(chunk).flatMap(frame => (frame.stream === 'stdout' ? stdout : stderr).push(frame.data)),
        flush: () => [...stdout.flush(), ...stderr.flush()],
    }
}
