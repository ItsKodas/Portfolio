import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        // server-only throws when imported outside a React server build, which is what keeps server code out of the
        // browser. Tests import that code directly, so here it resolves to an empty module instead.
        alias: { 'server-only': fileURLToPath(new URL('./server/testing/serverOnly.ts', import.meta.url)) },
    },
    test: {
        environment: 'node',
        include: ['app/**/*.test.ts', 'server/**/*.test.ts'],
        // The database test files share one real Postgres and TRUNCATE overlapping tables (Quote, Note) in
        // beforeEach. Running files in parallel lets one file's TRUNCATE land mid-test in another, so files run
        // one at a time; within a file, tests still run in the order they're written.
        fileParallelism: false,
    },
})
