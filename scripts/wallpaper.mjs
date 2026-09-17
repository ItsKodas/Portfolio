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
