import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        // Exact-match regexes rather than the object form, whose matching is by prefix: a bare 'next/server'
        // key would also rewrite 'next/server.js' and point it at itself twice over.
        alias: [
            {
                // server-only throws when imported outside a React server build, which is what keeps server code out
                // of the browser. Tests import that code directly, so here it resolves to an empty module instead.
                find: /^server-only$/,
                replacement: fileURLToPath(new URL('./server/testing/serverOnly.ts', import.meta.url)),
            },
            {
                // tsconfig.json maps @/* to the repo root. Vite does not read that, so a test importing a
                // module that uses the alias (a page under app/ does) would not resolve without this.
                find: /^@\//,
                replacement: fileURLToPath(new URL('./', import.meta.url)),
            },
            {
                // next ships no "exports" map for ./server, so the bare specifier only resolves under CommonJS,
                // which guesses the extension. next-auth is ESM and Node's ESM resolver does not guess, so
                // importing middleware.ts (which builds a NextAuth instance at module scope) dies on
                // next-auth/lib/env.js before a single test runs. Naming the file is what next/server means.
                find: /^next\/server$/,
                replacement: fileURLToPath(new URL('./node_modules/next/server.js', import.meta.url)),
            },
        ],
    },
    test: {
        environment: 'node',
        // next-auth is ESM and would otherwise be handed straight to Node, which resolves its bare
        // 'next/server' import against next's package.json, finds no "exports" entry for it and gives up
        // without guessing the extension. Inlining runs it through Vite instead, where the alias above
        // answers that specifier. Without this, importing middleware.ts fails before any test runs.
        server: { deps: { inline: ['next-auth', '@auth/core'] } },
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
                    include: ['app/**/*.test.ts', 'server/**/*.test.ts', 'ui/**/*.test.ts', 'scripts/**/*.test.ts', 'middleware.test.ts'],
                    exclude: ['server/clients/model.test.ts', 'server/clients/repo.test.ts', 'server/quotes/repo.test.ts'],
                },
            },
            {
                extends: true,
                test: {
                    name: 'db',
                    include: ['server/clients/model.test.ts', 'server/clients/repo.test.ts', 'server/quotes/repo.test.ts'],
                    // Both files run against the same real Postgres and TRUNCATE overlapping tables (Quote,
                    // Note) in beforeEach, so one file's TRUNCATE can land mid-test in the other. A single fork
                    // gives this project exactly one worker, so its files run one after another instead of
                    // racing; within a file, tests still run in the order they're written.
                    pool: 'forks',
                    poolOptions: { forks: { singleFork: true } },
                },
            },
            {
                extends: true,
                // tsconfig.json sets jsx: "preserve", because Next does the transform itself. esbuild reads
                // that and falls back to the classic React.createElement transform, which needs React in
                // scope in every test file. The automatic runtime is what Next compiles with, so the tests
                // compile the same way the app does.
                esbuild: { jsx: 'automatic' },
                test: {
                    // Named for what it provides rather than for one directory: a page under app/ needs the
                    // same DOM a component in ui/ does, and there is no second thing to call it.
                    name: 'dom',
                    // Components need a DOM, which the other two projects deliberately do without.
                    environment: 'jsdom',
                    include: ['ui/**/*.test.tsx', 'app/**/*.test.tsx'],
                    setupFiles: ['./ui/testing/setup.ts'],
                },
            },
        ],
    },
})
