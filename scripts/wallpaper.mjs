// Builds the desktop wallpaper (app/wallpaper) into dist/wallpaper-engine, a folder Wallpaper Engine can open as a web
// wallpaper: in the Wallpaper Engine editor, Create Wallpaper, then pick dist/wallpaper-engine/index.html (or, once
// imported, the folder can be published to the Workshop from there).
//
// Wallpaper Engine loads the page straight from disk, so the export's site-root paths (/_next/...) are rewritten to be
// relative to the page, and the stylesheets' font paths to be relative to the stylesheets.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = '.next-wallpaper' // (with a build folder of its own set, the export is written there too)
const DIST = join('dist', 'wallpaper-engine')

// Next adds its build folder's types to tsconfig.json on a build; the wallpaper's is a side build, so put it back after
const tsconfig = readFileSync('tsconfig.json', 'utf8')
const build = spawnSync('npx next build', { stdio: 'inherit', shell: true, env: { ...process.env, WALLPAPER_EXPORT: '1' } })
writeFileSync('tsconfig.json', tsconfig)
if (build.status !== 0) process.exit(build.status ?? 1)

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })
cpSync(join(OUT, '_next'), join(DIST, '_next'), { recursive: true })
cpSync(join(OUT, 'wallpaper.html'), join(DIST, 'index.html'))
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
