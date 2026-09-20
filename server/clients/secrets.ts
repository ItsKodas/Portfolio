// TOTP secrets and recovery codes at rest. The nightly pg_dump sits on the same disk as the database, so a dump
// that leaks must not hand anyone working second factors.

import 'server-only'

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Prefixed to every ciphertext, so a future key rotation can tell which key made which value
const VERSION = 'v1'
const IV_LENGTH = 12
export const KEY_LENGTH = 32

export class SecretError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SecretError'
    }
}

const checkKey = (key: Buffer) => {
    if (key.length !== KEY_LENGTH) throw new SecretError('The client secret key must be 32 bytes')
}

export function encryptSecret(plaintext: string, key: Buffer): string {
    checkKey(key)
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('$')
}

// Throws rather than returning null on purpose. A secret that won't decrypt means the key is wrong or the row
// was tampered with, and sign-in must refuse rather than quietly treat the client as having no second factor.
export function decryptSecret(stored: string, key: Buffer): string {
    checkKey(key)
    const parts = stored.split('$')
    if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretError('Unrecognised secret format')
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'))
        decipher.setAuthTag(Buffer.from(parts[2], 'base64'))
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8')
    } catch {
        // GCM's tag check lands here when the key is wrong or a byte changed
        throw new SecretError('The stored secret could not be read')
    }
}

// Keyed rather than plain SHA-256, so a database dump alone doesn't let anyone check guesses offline. A fast
// hash is sound here, unlike for a password, because we generate these codes at full entropy.
export const hashRecoveryCode = (normalisedCode: string, key: Buffer) =>
    createHmac('sha256', key).update(normalisedCode).digest('hex')

export function recoveryCodeMatches(normalisedCode: string, storedHash: string, key: Buffer): boolean {
    const candidate = Buffer.from(hashRecoveryCode(normalisedCode, key), 'hex')
    const stored = Buffer.from(storedHash, 'hex')
    if (candidate.length !== stored.length) return false
    return timingSafeEqual(candidate, stored)
}
