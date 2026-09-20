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
        // Split into projects so only the two database-backed files are forced to run one at a time.
        // `fileParallelism` (and `maxWorkers`) can't be set per project, only at the root, where it would
        // serialise every test file in the repo forever just to fix a collision between two of them. A
        // dedicated single-fork project gets the same one-at-a-time guarantee for just those two files, while
        // every other test file keeps running in parallel.
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['app/**/*.test.ts', 'server/**/*.test.ts'],
                    exclude: ['server/clients/model.test.ts', 'server/quotes/repo.test.ts'],
                },
            },
            {
                extends: true,
                test: {
                    name: 'db',
                    include: ['server/clients/model.test.ts', 'server/quotes/repo.test.ts'],
                    // Both files run against the same real Postgres and TRUNCATE overlapping tables (Quote,
                    // Note) in beforeEach, so one file's TRUNCATE can land mid-test in the other. A single fork
                    // gives this project exactly one worker, so its files run one after another instead of
                    // racing; within a file, tests still run in the order they're written.
                    pool: 'forks',
                    poolOptions: { forks: { singleFork: true } },
                },
            },
        ],
    },
})
