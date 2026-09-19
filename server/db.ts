// The Prisma client. Created on first use rather than on import, so building the site (which imports this without a
// database) never tries to connect.

import 'server-only'

import { PrismaPg } from '@prisma/adapter-pg'

import { PrismaClient } from './generated/prisma/client'

export function createDb(connectionString: string): PrismaClient {
    return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

// One client per process. In development Next reloads modules on every change, so the client lives on globalThis
// rather than opening a new connection pool each time.
const cache = globalThis as unknown as { horizonsDb?: PrismaClient }

export function getDb(): PrismaClient {
    if (!cache.horizonsDb) {
        const url = process.env.DATABASE_URL
        if (!url) throw new Error('DATABASE_URL is not set')
        cache.horizonsDb = createDb(url)
    }
    return cache.horizonsDb
}
