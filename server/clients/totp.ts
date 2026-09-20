// RFC 6238 time-based one-time passwords, written here rather than taken as a dependency because the RFCs
// publish test vectors, so "this matches the standard" is a test result rather than a claim about a package.

import 'server-only'

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// RFC 4648 base32, which is what authenticator apps read
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(data: Buffer): string {
    let bits = 0
    let value = 0
    let out = ''
    for (const byte of data) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 5) {
            out += BASE32[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    // Whatever is left over is padded out to a full character, then to a full eight character group
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
    while (out.length % 8 !== 0) out += '='
    return out
}

export function base32Decode(text: string): Buffer {
    // Tolerant of what a person types: lower case, spaces, and the padding left off
    const clean = text.toUpperCase().replace(/\s+/g, '').replace(/=+$/, '')
    let bits = 0
    let value = 0
    const out: number[] = []
    for (const character of clean) {
        const index = BASE32.indexOf(character)
        if (index < 0) throw new Error(`Not base32: ${character}`)
        value = (value << 5) | index
        bits += 5
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255)
            bits -= 8
        }
    }
    return Buffer.from(out)
}

// HMAC-SHA1 because that is the RFC default and what authenticator apps implement. The collision work against
// SHA-1 does not apply to HMAC-SHA1.
export function hotp(secret: Buffer, counter: bigint, digits = 6): string {
    const message = Buffer.alloc(8)
    message.writeBigUInt64BE(counter)
    const mac = createHmac('sha1', secret).update(message).digest()
    // RFC 4226 dynamic truncation: the low nibble of the last byte picks where to read four bytes from
    const offset = mac[mac.length - 1] & 0x0f
    const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
    return String(binary % 10 ** digits).padStart(digits, '0')
}

export const STEP_SECONDS = 30
// One step either side, so about 90 seconds of tolerance for a phone whose clock is slightly out
export const WINDOW = 1

export const stepFor = (now: Date) => BigInt(Math.floor(now.getTime() / 1000 / STEP_SECONDS))

// Returns the step that matched rather than a boolean, because the caller records it so the same code cannot
// be used twice inside its own window.
export function verifyTotp(secret: Buffer, code: string, now: Date, window = WINDOW): bigint | null {
    const typed = code.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(typed)) return null
    const typedBuffer = Buffer.from(typed, 'ascii')
    const current = stepFor(now)
    for (let drift = -window; drift <= window; drift += 1) {
        const step = current + BigInt(drift)
        // Both are six ASCII digits, so the lengths always match and timingSafeEqual never throws
        if (timingSafeEqual(Buffer.from(hotp(secret, step), 'ascii'), typedBuffer)) return step
    }
    return null
}

// 20 bytes, as RFC 4226 recommends for HMAC-SHA1
export const newTotpSecret = (random: (bytes: number) => Buffer = randomBytes) => random(20)

export function otpauthUri(options: { secret: Buffer, email: string, issuer?: string }): string {
    const issuer = options.issuer ?? 'Horizons'
    const label = encodeURIComponent(`${issuer}:${options.email}`)
    const params = new URLSearchParams({
        // Unpadded: some apps refuse a secret with trailing equals signs
        secret: base32Encode(options.secret).replace(/=+$/, ''),
        issuer,
        algorithm: 'SHA1',
        digits: '6',
        period: String(STEP_SECONDS),
    })
    return `otpauth://totp/${label}?${params.toString()}`
}

// Shown beside the QR code, for a phone that will not scan
export const formatSecretForTyping = (secret: Buffer) =>
    base32Encode(secret).replace(/=+$/, '').replace(/(.{4})/g, '$1 ').trim()
