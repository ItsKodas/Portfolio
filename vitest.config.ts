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
    },
})
