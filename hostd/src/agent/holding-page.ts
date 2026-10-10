// The holding page a visitor meets while a site is not serving: the Horizons landing page's closing night
// scene (mountains, a lake and a campfire on the shore), with the site's name, why it is down, and who to
// reach about it. One self-contained file per environment, rendered here and written by holding-pages.ts:
// Apache serves it from the maintenance directory as the ErrorDocument for every 503, so it can load
// nothing from the site it stands in for, and nothing from anywhere else either.

import { readFileSync } from 'node:fs'
import type { Contact } from '../shared/registry.ts'

// Why the site is down, as far as hostd can tell. upgrading is a deploy's swap (the maintenance flag is
// up), stopped is a site container that was taken down on purpose, crashed is one that keeps dying or
// died and stayed down, and unavailable is everything else: running but not answering, or not yet looked at.
export const HOLDING_STATES = ['upgrading', 'stopped', 'crashed', 'unavailable'] as const
export type HoldingState = typeof HOLDING_STATES[number]

export type HoldingPageInput = {
    // null for the shared fallback page, which stands in for every site and so knows none of them by name
    name: string | null
    hostname: string | null
    // Shown only when it is not live: a visitor to a test address should be told it is one
    environment: string | null
    state: HoldingState
    // When hostd first saw the site in this state, as an ISO timestamp
    since: string | null
    contact: Contact | null
}

// The landing page's own footer scene (app/(landing)/night/footer.svg), copied in rather than imported:
// hostd builds from its own directory and cannot reach the portal's.
const SCENE = readFileSync(new URL('./holding-scene.svg', import.meta.url), 'utf8').trim()

// Where the campfire sits in the scene's canvas (app/(landing)/night/campfire.ts). The page's .land rule
// leans on FX too: on a screen too narrow for the whole scene it centres the crop on the fire (.307 is
// FX / 3840) rather than on the middle of the lake, which would leave a phone with no campfire at all.
const FX = 1180
const FY = 1190

const STATE_COPY: Record<HoldingState, { label: string, lead: (name: string) => string, body: (contact: boolean) => string }> = {
    upgrading: {
        label: 'Upgrading',
        lead: name => `A new version of ${name} is being put in place.`,
        body: () => 'This usually only takes a minute or two. There is nothing you need to do: this page will take you back to the site as soon as it is ready.',
    },
    stopped: {
        label: 'Offline for now',
        lead: name => `${name} is offline for now.`,
        // Honest that it was taken down on purpose, without a promise of when it returns (only its owner
        // knows) and without wording that would put a visitor off coming back
        body: contact => `The site's owner has taken it offline for the time being, so nothing has gone wrong. Please check back later.${contact ? ' Need something in the meantime? You can reach them below.' : ''}`,
    },
    crashed: {
        label: 'Having trouble',
        lead: name => `${name} is having some trouble right now.`,
        body: contact => `It has run into a technical problem and is not available at the moment.${contact ? ' If you need something urgently, you can reach the site\'s owner below.' : ' Please check back later.'}`,
    },
    unavailable: {
        label: 'Back shortly',
        lead: name => `${name} is not answering right now.`,
        body: () => 'It should be back shortly. This page checks again by itself and will take you to the site as soon as it answers.',
    },
}

// The shared fallback stands in for every site and knows nothing about any of them, so it says nothing
// about why or for how long: "back shortly" would be a promise it has no grounds for
const FALLBACK_COPY = {
    label: 'Unavailable',
    lead: () => 'This site is not available right now.',
    body: () => 'Please check back later. This page checks again by itself and will take you to the site once it is back.',
}

// Each state's accent, taken from the landing page's palette: the lake's blue, the sky's lilac, the
// clouds' pink and the campfire's amber
const ACCENT: Record<HoldingState, string> = {
    upgrading: '#8fd4f5',
    stopped: '#b597cc',
    crashed: '#f19bb3',
    unavailable: '#ffc27a',
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// Every value that reaches the page from the registry goes through this, including the ones the registry
// already held to a shape: the shape is what keeps a link working, this is what keeps markup out.
export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, character => ENTITIES[character]!)
}

// Stable pseudo-random numbers, the same formula the landing page's stars use, so a re-render does not
// rearrange the sky and the file only changes when something it says does
const r = (i: number, k: number) => Math.abs(Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1

function stars(): string {
    return Array.from({ length: 80 }, (_, i) => {
        const size = (1 + Math.pow(r(i, 3), 3) * 2).toFixed(1)
        const twinkle = r(i, 5) < 0.3
        const style = [
            `left:${(r(i, 1) * 100).toFixed(2)}%`,
            `top:${(2 + r(i, 2) * 70).toFixed(2)}%`,
            `width:${size}px`, `height:${size}px`,
            `opacity:${(0.15 + r(i, 4) * 0.4).toFixed(2)}`,
            ...(twinkle ? [`animation-duration:${(3 + r(i, 6) * 4).toFixed(1)}s`, `animation-delay:${(-r(i, 7) * 6).toFixed(1)}s`] : []),
        ].join(';')
        return `<i class="star${twinkle ? ' twinkle' : ''}" style="${style}"></i>`
    }).join('')
}

// The campfire's moving parts, drawn into the scene itself so they stay pinned to the logs however the
// scene is cropped: a glow, three flames that each flicker from their base, and sparks drifting up
function campfire(): string {
    const flames = [
        { fill: '#ff7a2a', duration: '0.9s', delay: '0s', d: `M${FX - 48} ${FY} C${FX - 60} ${FY - 60} ${FX - 20} ${FY - 100} ${FX - 6} ${FY - 150} C${FX + 20} ${FY - 96} ${FX + 58} ${FY - 60} ${FX + 48} ${FY}Z` },
        { fill: '#ffb13a', duration: '0.7s', delay: '-0.3s', d: `M${FX - 32} ${FY} C${FX - 40} ${FY - 44} ${FX - 8} ${FY - 70} ${FX + 4} ${FY - 108} C${FX + 16} ${FY - 66} ${FX + 40} ${FY - 40} ${FX + 32} ${FY}Z` },
        { fill: '#fff1a8', duration: '0.55s', delay: '-0.2s', d: `M${FX - 16} ${FY} C${FX - 20} ${FY - 24} ${FX - 2} ${FY - 40} ${FX + 2} ${FY - 62} C${FX + 10} ${FY - 38} ${FX + 20} ${FY - 22} ${FX + 16} ${FY}Z` },
    ].map(f => `<path class="flame" d="${f.d}" fill="${f.fill}" style="animation-duration:${f.duration};animation-delay:${f.delay}"/>`)
    const sparks = Array.from({ length: 9 }, (_, i) => {
        const dx = Math.round((r(i, 11) - 0.5) * 60)
        const style = [
            `--rise:${-Math.round(160 + r(i, 13) * 220)}px`,
            `--drift:${Math.round((r(i, 12) - 0.5) * 120)}px`,
            `animation-duration:${(1.6 + r(i, 14) * 1.6).toFixed(2)}s`,
            `animation-delay:${(-r(i, 15) * 3).toFixed(2)}s`,
        ].join(';')
        return `<circle class="spark" cx="${FX + dx}" cy="${FY - 60}" r="4" fill="#ffd27a" style="${style}"/>`
    })
    // A few slow glints on the water below the fire, where its light already falls in the scene
    const glints = Array.from({ length: 5 }, (_, i) => {
        const y = 1268 + i * 26
        const w = 70 - i * 9
        const x = FX - w / 2 + Math.round((r(i, 21) - 0.5) * 40)
        return `<rect class="glint" x="${x}" y="${y}" width="${w}" height="3" rx="1.5" fill="#ffc98a" style="animation-delay:${(-r(i, 22) * 5).toFixed(1)}s"/>`
    })
    return `<g aria-hidden="true">
<defs><radialGradient id="campGlow"><stop offset="0" stop-color="#ffb35c" stop-opacity="0.55"/><stop offset="0.4" stop-color="#ff8a3c" stop-opacity="0.18"/><stop offset="1" stop-color="#ff8a3c" stop-opacity="0"/></radialGradient></defs>
<circle class="glow" cx="${FX}" cy="${FY - 30}" r="260" fill="url(#campGlow)"/>
${glints.join('')}
${flames.join('')}
${sparks.join('')}
</g>`
}

function scene(): string {
    const at = SCENE.lastIndexOf('</svg>')
    const svg = SCENE.slice(0, at).replace('<svg ', '<svg class="scene" aria-hidden="true" focusable="false" ')
    return `${svg}${campfire()}</svg>`
}

function contactSection(contact: Contact): string {
    const links: string[] = []
    if (contact.email) links.push(`<a href="mailto:${escapeHtml(contact.email)}"><span>Email</span>${escapeHtml(contact.email)}</a>`)
    if (contact.phone) links.push(`<a href="tel:${escapeHtml(contact.phone.replace(/[^0-9+]/g, ''))}"><span>Phone</span>${escapeHtml(contact.phone)}</a>`)
    const who = contact.name ? escapeHtml(contact.name) : 'the site owner'
    return `<section class="contact">
<h2>Need to reach ${who}?</h2>
<div class="links">${links.join('')}</div>
</section>`
}

export function renderHoldingPage(input: HoldingPageInput): string {
    const copy = input.name === null ? FALLBACK_COPY : STATE_COPY[input.state]
    const name = input.name === null ? null : escapeHtml(input.name)
    const hostname = input.hostname === null ? null : escapeHtml(input.hostname)
    // The fallback page knows no site, so it says "This site" and lets the script put the address in
    const subject = name ?? 'This site'
    const facts: string[] = []
    if (hostname) facts.push(`<div><dt>Address</dt><dd>${hostname}</dd></div>`)
    else facts.push('<div data-address hidden><dt>Address</dt><dd></dd></div>')
    if (input.environment && input.environment !== 'live') facts.push(`<div><dt>Environment</dt><dd>${escapeHtml(input.environment)}</dd></div>`)
    facts.push(`<div><dt>Status</dt><dd>${copy.label}</dd></div>`)
    if (input.since) {
        const since = escapeHtml(input.since)
        facts.push(`<div><dt>Since</dt><dd><time datetime="${since}">${since.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC')}</time></dd></div>`)
    }
    const accent = ACCENT[input.state]

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0d1524">
<title>${name ? `${name} · ` : ''}${copy.label}</title>
<style>
:root{--accent:${accent};--text:#dbe6f7;--muted:rgba(180,195,220,.78);--faint:#8fa3c7;--panel:rgba(17,26,56,.55);--edge:rgba(143,212,245,.12)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;color:var(--text);font-family:Montserrat,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;overflow-x:hidden;
background:radial-gradient(ellipse 55% 30% at 18% 22%,rgba(90,79,147,.24),transparent 70%),radial-gradient(ellipse 50% 26% at 82% 46%,rgba(63,155,219,.12),transparent 70%),linear-gradient(to bottom,#0d1524 0%,#111a38 35%,#171c48 70%,#141a3e 100%) fixed;background-color:#0d1524}
.sky{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.star{position:absolute;border-radius:50%;background:#e6f0ff}
.twinkle{animation:twinkle ease-in-out infinite}
@keyframes twinkle{0%,100%{opacity:.1}50%{opacity:.6}}
.land{--h:clamp(200px,40vh,520px);--w:max(100vw,calc(var(--h) * 3840 / 1400));position:fixed;bottom:0;height:var(--h);width:var(--w);left:clamp(calc(100vw - var(--w)),calc(50vw - var(--w) * .307),0px);pointer-events:none}
.scene{display:block;width:100%;height:100%}
.glow{transform-box:fill-box;transform-origin:center;animation:glow 2.4s ease-in-out infinite}
@keyframes glow{0%,100%{opacity:.75;transform:scale(.95)}30%{opacity:1;transform:scale(1.04)}60%{opacity:.85;transform:scale(.98)}}
.flame{transform-box:fill-box;transform-origin:50% 100%;animation:flame ease-in-out infinite alternate}
@keyframes flame{0%{transform:scale(1,1) skewX(0)}50%{transform:scale(.92,1.12) skewX(-4deg)}100%{transform:scale(1.05,.9) skewX(3deg)}}
.spark{opacity:0;animation:spark ease-out infinite}
@keyframes spark{0%{transform:translate(0,0);opacity:0}15%{opacity:1}100%{transform:translate(var(--drift),var(--rise));opacity:0}}
.glint{opacity:0;animation:glint 5s ease-in-out infinite}
@keyframes glint{0%,100%{opacity:0}50%{opacity:.35}}
main{position:relative;z-index:1;width:calc(100% - 2rem);max-width:34rem;margin:clamp(2.5rem,12vh,8rem) 1rem calc(clamp(200px,40vh,520px) * .55);padding:2rem 1.75rem;border:1px solid var(--edge);border-radius:1.5rem;background:var(--panel);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 20px 60px -30px rgba(0,0,0,.6)}
.eyebrow{display:flex;align-items:center;gap:.6rem;margin-bottom:1rem;font-size:.72rem;font-weight:600;letter-spacing:.3em;text-transform:uppercase;color:var(--accent)}
.dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--accent);box-shadow:0 0 0 0 var(--accent);animation:pulse 2.4s ease-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 60%,transparent)}70%,100%{box-shadow:0 0 0 .5rem transparent}}
h1{font-size:clamp(1.8rem,6vw,2.4rem);font-weight:700;letter-spacing:-.02em;line-height:1.15;color:#fff;overflow-wrap:anywhere}
.lead{margin-top:.75rem;font-size:1.05rem;font-weight:500;color:var(--text)}
.body{margin-top:.6rem;font-size:.95rem;color:var(--muted)}
dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem 1.25rem;margin-top:1.5rem;padding-top:1.25rem;border-top:1px solid var(--edge)}
dt{font-size:.68rem;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--faint)}
dd{margin-top:.15rem;font-size:.92rem;color:#fff;overflow-wrap:anywhere}
.contact{margin-top:1.5rem;padding-top:1.25rem;border-top:1px solid var(--edge)}
h2{font-size:.95rem;font-weight:600;color:#fff}
.links{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}
.links a{display:inline-flex;align-items:baseline;gap:.5rem;padding:.55rem 1rem;border:1px solid rgba(143,212,245,.22);border-radius:999px;background:rgba(143,212,245,.06);color:#bfe6fb;font-size:.88rem;font-weight:500;text-decoration:none;overflow-wrap:anywhere;transition:border-color .2s,color .2s}
.links a:hover,.links a:focus-visible{border-color:rgba(143,212,245,.5);color:#fff;outline:none}
.links span{font-size:.66rem;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:rgba(143,212,245,.7)}
.check{margin-top:1.5rem;font-size:.78rem;color:var(--faint)}
footer{position:relative;z-index:1;margin:auto 0 .9rem;padding-top:1rem;text-align:center;font-size:.68rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(219,230,247,.45)}
footer a{color:inherit;text-decoration:none}
footer a:hover{color:#fff}
@media (prefers-reduced-motion:reduce){.twinkle,.glow,.flame,.spark,.glint,.dot{animation:none}.spark{opacity:0}}
</style>
</head>
<body>
<div class="sky" aria-hidden="true">${stars()}</div>
<div class="land">${scene()}</div>
<main>
<p class="eyebrow"><span class="dot"></span>${copy.label}</p>
<h1>${name ?? '<span data-host>This site</span>'}</h1>
<p class="lead">${copy.lead(subject)}</p>
<p class="body">${copy.body(input.contact !== null)}</p>
<dl>${facts.join('')}</dl>
${input.contact ? contactSection(input.contact) : ''}
<p class="check" data-check>This page checks again every 30 seconds and reloads once the site is back.</p>
</main>
<footer>Hosted by <a href="https://horizons.gg/" rel="noopener">Horizons</a></footer>
<script>
(function () {
    var time = document.querySelector('time[datetime]')
    if (time) {
        var at = new Date(time.getAttribute('datetime'))
        if (!isNaN(at)) time.textContent = at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    }
    var host = document.querySelector('[data-host]')
    if (host) host.textContent = location.hostname
    var address = document.querySelector('[data-address]')
    if (address) { address.querySelector('dd').textContent = location.hostname; address.hidden = false }
    // Apache answers 503 for as long as the site is down, so anything else means it is back
    function check() {
        if (document.hidden) return
        fetch(location.href, { method: 'HEAD', cache: 'no-store', redirect: 'manual' })
            .then(function (response) { if (response.status !== 503) location.reload() })
            .catch(function () {})
    }
    setInterval(check, 30000)
})()
</script>
</body>
</html>
`
}
