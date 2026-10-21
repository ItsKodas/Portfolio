// Builds the project showcase's images (public/projects/<slug>/) from the screenshots folder and the projects' own
// repositories, so the originals are never touched and the site only ships small WebP copies.
//
//   node scripts/project-images.mjs --from "C:\Users\koda\OneDrive\Desktop\screenshots"
//
// The jobs are in project-images.json beside this file. Each one names a project, the output file name, the kind
// of image, and where it comes from: `from`, a path inside the --from folder; `local`, a path inside this repo; or
// `gh`, "owner/repo:path" fetched raw through the GitHub CLI. Running it again overwrites its own outputs.
//
// Screenshots become WebP at quality 80: desktop ones at most 1600 px wide, phone ones at most 800 px. A full-page
// capture far taller than it is wide is cut down to its top part first, since nothing shows a whole page at once.
// Logos stay SVG when they are SVG, and otherwise become PNGs of at most 256 px.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fromArg = process.argv.indexOf('--from')
const from = fromArg === -1 ? null : process.argv[fromArg + 1]

const LIMITS = {
    desktop: { width: 1600, tallest: 2, keep: 1 / 1.6 },   // keep: height as a share of width when cut down (16:10)
    mobile: { width: 800, tallest: 2.4, keep: 2.2 },
}

function source(job) {
    if (job.gh) {
        const [repo, path] = job.gh.split(/:(.+)/)
        return execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path}`],
            { maxBuffer: 64 * 1024 * 1024 })
    }
    if (job.local) return readFileSync(join(root, job.local))
    if (!from) throw new Error(`${job.slug}/${job.out} needs --from <screenshots folder>`)
    return readFileSync(join(from, job.from))
}

async function build(job) {
    const input = source(job)
    if (job.kind === 'logo') {
        if (job.out.endsWith('.svg')) return input
        return sharp(input).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    }
    const limit = LIMITS[job.kind]
    let image = sharp(input)
    const { width, height } = await image.metadata()
    if (height > width * limit.tallest) {
        image = sharp(await image.extract({ left: 0, top: 0, width, height: Math.round(width * limit.keep) }).toBuffer())
    }
    return image.resize({ width: limit.width, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
}

const jobs = JSON.parse(readFileSync(join(here, 'project-images.json'), 'utf8'))
for (const job of jobs) {
    const out = join(root, 'public', 'projects', job.slug, job.out)
    mkdirSync(dirname(out), { recursive: true })
    const data = await build(job)
    writeFileSync(out, data)
    console.log(`${job.slug}/${job.out}  ${Math.round(data.length / 1024)} KB`)
}
