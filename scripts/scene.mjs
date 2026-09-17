// Captures the hero exactly as the landing page draws it into app/scene.jpg, the backdrop the link preview is built on
// (see app/shareImage.tsx). Run by hand, `npm run scene`, whenever the scene's art changes; the site's own build never
// runs a browser, it just reads the committed image.
//
// The capture is the real page rather than a flattened copy of the artwork, so the parts that only exist once it is
// running (the stars, the drifting clouds, the fireflies, the lit watchtower) are in it. The viewport is the share
// image's own 1200x630, which leaves the framing to the site's object-cover rules instead of picking a crop here.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import sharp from 'sharp'

const OUT = join('app', 'scene.jpg')
const SIZE = { width: 1200, height: 630 }
const SCALE = 2         // captured at twice the size and scaled back down, so the stars and far trees stay clean
const QUALITY = 90
const CURTAIN_MS = 6000 // the curtain lifts by itself after 5s at the latest (see parallax/curtain.tsx)
const SETTLE_MS = 2500  // then a moment more, so the clouds and fireflies are somewhere natural rather than at frame one

// The parts of the page the share image draws itself, or that mean nothing in a still
const HIDE = `
    a[href="/wallpaper"],
    button[aria-label^="Need a website"] { display: none !important }
`

const chrome = () => {
    const candidates = [
        join(process.env['ProgramFiles'] ?? '', 'Google/Chrome/Application/chrome.exe'),
        join(process.env['ProgramFiles(x86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
        join(process.env['LOCALAPPDATA'] ?? '', 'Google/Chrome/Application/chrome.exe'),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ]
    const found = candidates.find(p => p && existsSync(p))
    if (!found) throw new Error('Chrome not found. It is only needed to run this script, never to build the site.')
    return found
}

const freePort = () => new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        server.close(() => resolve(port))
    })
})

const wait = (ms) => new Promise(r => setTimeout(r, ms))

async function until(what, check, timeout = 60000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (await check().catch(() => false)) return
        await wait(250)
    }
    throw new Error(`Timed out waiting for ${what}`)
}

// Just enough of the DevTools protocol to open a page, dress it and photograph it
async function connect(url) {
    const socket = new WebSocket(url)
    const pending = new Map()
    let next = 0
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', () => reject(new Error('Could not reach Chrome')), { once: true })
    })
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        const waiting = pending.get(message.id)
        if (!waiting) return
        pending.delete(message.id)
        message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result)
    })
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
    return { send, close: () => socket.close() }
}

async function capture(pageUrl) {
    const profile = mkdtempSync(join(tmpdir(), 'horizons-scene-'))
    const browser = spawn(chrome(), [
        '--headless=new', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--force-color-profile=srgb', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' })

    try {
        const portFile = join(profile, 'DevToolsActivePort')
        await until('Chrome to start', async () => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n'))
        const [port, path] = readFileSync(portFile, 'utf8').split('\n')
        const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
        const cdp = await connect(webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}${path}`)

        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
        const page = (method, params) => cdp.send(method, params, sessionId)

        await page('Page.enable')
        await page('Emulation.setDeviceMetricsOverride', { ...SIZE, deviceScaleFactor: SCALE, mobile: false })
        await page('Page.navigate', { url: pageUrl })
        await wait(CURTAIN_MS)

        // The logo and its buttons: the share image sets its own title, so the scene is captured without one. Hiding
        // the layer itself would take the sky with it in the lite hero, so this hides the logo's own root.
        await page('Runtime.evaluate', {
            expression: `(() => {
                const style = document.createElement('style')
                style.textContent = ${JSON.stringify(HIDE)}
                document.head.appendChild(style)
                const logo = document.querySelector('img[alt="Horizons logo"]')
                const root = logo && logo.closest('div[class*="canvas"]')
                if (root) root.style.setProperty('display', 'none', 'important')
                return !!root
            })()`,
        }).then(({ result }) => {
            if (!result.value) console.warn('  (could not find the logo to hide; check the capture)')
        })

        await wait(SETTLE_MS)
        const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        cdp.close()
        return Buffer.from(data, 'base64')
    } finally {
        browser.kill()
        // Chrome holds its profile open for a moment after being asked to stop, and a leftover temp folder is no
        // reason to fail a capture that worked
        await new Promise(resolve => browser.once('exit', resolve)).catch(() => {})
        try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { }
    }
}

// ─── Run ──────────────────────────────────────────────────────────────────────

if (!existsSync(join('.next', 'BUILD_ID'))) {
    console.log('No build to capture from, building first...')
    const build = spawnSync('npx next build', { stdio: 'inherit', shell: true })
    if (build.status !== 0) process.exit(build.status ?? 1)
}

const port = await freePort()
const site = spawn(`npx next start -p ${port}`, { stdio: 'ignore', shell: true })

try {
    await until('the site to start', async () => (await fetch(`http://127.0.0.1:${port}/`)).ok)
    console.log(`Capturing the hero at ${SIZE.width}x${SIZE.height} (at ${SCALE}x)...`)
    const shot = await capture(`http://127.0.0.1:${port}/`)

    await sharp(shot).resize(SIZE.width, SIZE.height).jpeg({ quality: QUALITY, mozjpeg: true }).toFile(OUT)
    const { size } = await sharp(OUT).metadata().then(async m => ({ ...m, size: (await sharp(OUT).toBuffer()).length }))
    console.log(`Wrote ${OUT} (${(size / 1024).toFixed(0)} KB)`)
} finally {
    site.kill()
    // next start leaves the server holding the port on Windows unless the whole tree goes
    if (process.platform === 'win32' && site.pid) spawnSync(`taskkill /pid ${site.pid} /T /F`, { stdio: 'ignore', shell: true })
}
