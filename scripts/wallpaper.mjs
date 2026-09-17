// Builds the desktop wallpaper (app/wallpaper) into dist/wallpaper-engine, a folder Wallpaper Engine can open as a web
// wallpaper: in the Wallpaper Engine editor, Create Wallpaper, then pick dist/wallpaper-engine/index.html (or, once
// imported, the folder can be published to the Workshop from there).
//
// The static export is built from a copy of the project in .wallpaper-build (which finds the dependencies in the
// project's own node_modules, one folder up), as Next always builds into .next, which would pull the rug out from under
// a running dev server (or replace the site's own build).
//
// Wallpaper Engine loads the page straight from disk, so the export's site-root paths (/_next/...) are rewritten to be
// relative to the page, and the stylesheets' font paths to be relative to the stylesheets.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIST = join('dist', 'wallpaper-engine')
const SOURCES = ['app', 'public', 'themes', 'global.d.ts', 'next.config.ts', 'tsconfig.json', 'tailwind.config.ts',
    'postcss.config.mjs', 'eslint.config.mjs', 'package.json', 'package-lock.json']

const work = '.wallpaper-build'
rmSync(work, { recursive: true, force: true })
let status = 0
try {
    for (const source of SOURCES) cpSync(source, join(work, source), { recursive: true })

    const build = spawnSync('npx next build', { cwd: work, stdio: 'inherit', shell: true, env: { ...process.env, WALLPAPER_EXPORT: '1' } })
    status = build.status ?? 1
    if (status === 0) {
        const out = join(work, 'out')
        rmSync(DIST, { recursive: true, force: true })
        mkdirSync(DIST, { recursive: true })
        cpSync(join(out, '_next'), join(DIST, '_next'), { recursive: true })
        cpSync(join(out, 'wallpaper.html'), join(DIST, 'index.html'))
    }
} finally {
    rmSync(work, { recursive: true, force: true })
}
if (status !== 0) process.exit(status)

for (const file of ['project.json', 'preview.jpg']) {
    if (existsSync(join('wallpaper-engine', file))) cpSync(join('wallpaper-engine', file), join(DIST, file))
}

const files = dir => readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
})

const rewrite = (path, fix) => {
    const text = readFileSync(path, 'utf8')
    const fixed = fix(text)
    if (fixed !== text) writeFileSync(path, fixed)
}

for (const path of [join(DIST, 'index.html'), ...files(join(DIST, '_next'))]) {
    if (/\.(html|js)$/.test(path)) rewrite(path, t => t.replace(/(?<![\w.])\/_next\//g, './_next/'))
    else if (path.endsWith('.css')) rewrite(path, t => t.replace(/url\((['"]?)\/_next\/static\//g, 'url($1../'))
}

console.log(`\nWallpaper built into ${DIST}`)

// With --serve, the built folder is then served over HTTP, so the exact bundle Wallpaper Engine loads can be opened in
// a browser (the "wallpaper" entry in .claude/launch.json uses this). The page is built for a file:// root, so its
// relative paths work here unchanged.
if (process.argv.includes('--serve')) {
    const { createServer } = await import('node:http')
    const { extname, normalize, resolve } = await import('node:path')

    const port = Number(process.env.PORT) || 3001
    const root = resolve(DIST)
    const TYPES = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
        '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon',
        '.woff': 'font/woff', '.woff2': 'font/woff2',
    }

    createServer((request, response) => {
        const asked = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
        const file = resolve(root, '.' + normalize(asked === '/' ? '/index.html' : asked))
        // Nothing outside the built folder is served.
        if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            return response.end('Not found')
        }
        response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
        response.end(readFileSync(file))
    }).listen(port, () => console.log(`Serving ${DIST} on http://localhost:${port}`))
}
