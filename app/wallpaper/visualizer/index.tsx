'use client'

// The sound playing on the computer, rising out of the mountains right across the screen: the left channel on the left
// and the right channel mirrored on the right, the bass in the middle running out to the treble at the edges. It's
// drawn behind the far mountains (see the scene's sound layer), in the art's own canvas units so each line stands just
// below the skyline wherever it is (see skyline.ts) and climbs out of it, fading in from its base to its tip. From
// Wallpaper Engine's audio listener (see mediaScript.ts), so only in Wallpaper Engine; elsewhere nothing's drawn and
// nothing runs. As bars, or a smooth wave, in white or the colour of the album art that's playing.

import { useEffect, useRef } from 'react'

import { ArtCanvas, CANVAS, Piece, type Box } from '@/app/(landing)/parallax/art'

import { useNowPlaying } from '../media'
import { useSettings } from '../settings'
import { skylineAt } from './skyline'
import styles from './visualizer.module.css'

const BARS_PER_SIDE = 12   // each from a share of the 64 levels a channel comes in
const HIGHEST_BIN = 44     // the levels above this are near enough always silent, so they're left out
const RISE = 0.55          // how much of the way up to a louder level a line goes each frame
const FALL = 0.9           // and how much of its height it keeps each frame as it falls back
const SILENT = 0.002       // below this everything counts as silent, and nothing's drawn
const LIFT = 0.7           // levels are raised to this power, lifting the quieter ones (they mostly sit well below 1)
const BELOW = 70           // how far below the skyline the lines stand, in canvas units, so their feet stay hidden
const FADE = 0.25          // the share of a line, from its base up, over which it fades in from nothing
const SCREEN = CANVAS.height / 2 // a screen's height in canvas units (the art is two screens tall)

// The part of the canvas the sound is drawn in: the full width, from the top down past the lowest the skyline gets
const BOX: Box = { x: 0, y: 0, w: CANVAS.width, h: 1950 }

// Which of a channel's levels each line is the loudness of: the lowest few for the bass line in the middle, widening
// towards the treble at the edges, which has less going on to show
const BINS = Array.from({ length: BARS_PER_SIDE }, (_, bar) => {
    const edge = (at: number) => Math.round(HIGHEST_BIN * (at / BARS_PER_SIDE) ** 2.2)
    const from = edge(bar)
    return [from, Math.max(edge(bar + 1), from + 1)]
})

// A CSS colour as its red, green and blue, by way of a canvas (which normalises any colour to #rrggbb)
function rgb(ctx: CanvasRenderingContext2D, color: string) {
    ctx.fillStyle = '#ffffff'
    ctx.fillStyle = color
    const hex = String(ctx.fillStyle)
    const n = parseInt(hex.slice(1), 16)
    return hex.startsWith('#') && hex.length === 7 ? `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}` : '255, 255, 255'
}

export default function Visualizer() {
    const { visualizer, visualizerStyle, visualizerHeight, visualizerColor, visualizerOpacity, paused } = useSettings()
    const track = useNowPlaying()
    const color = (visualizerColor === 'album' && track?.color) || '#ffffff'

    // The latest look, for the drawing loop to pick up without restarting
    const look = useRef({ style: visualizerStyle, height: visualizerHeight, color, opacity: visualizerOpacity })
    look.current = { style: visualizerStyle, height: visualizerHeight, color, opacity: visualizerOpacity }

    const canvasRef = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (!visualizer || paused || !canvas || !ctx || !window.__wallpaperMedia?.audioSupported) return

        const levels = new Float32Array(BARS_PER_SIDE * 2) // left to right across the canvas
        let frame = 0, blank = false

        const draw = () => {
            frame = requestAnimationFrame(draw)

            const audio = window.__wallpaperMedia?.audio
            let loudest = 0
            for (let slot = 0; slot < levels.length; slot++) {
                // Both channels' bass meets in the middle: the left channel runs out to the left edge, the right to the right
                const right = slot >= BARS_PER_SIDE
                const bar = right ? slot - BARS_PER_SIDE : BARS_PER_SIDE - 1 - slot
                const [from, to] = BINS[bar]
                let level = 0
                for (let bin = from; bin < to; bin++) level += audio?.[(right ? 64 : 0) + bin] ?? 0
                const target = audio ? Math.min(1, level / (to - from)) ** LIFT : 0
                levels[slot] = target > levels[slot] ? levels[slot] + (target - levels[slot]) * RISE : levels[slot] * FALL
                loudest = Math.max(loudest, levels[slot])
            }

            // Sized to the canvas as shown, at the screen's pixel density, and drawn in the art's canvas units
            const density = window.devicePixelRatio || 1
            const width = Math.round(canvas.clientWidth * density), height = Math.round(canvas.clientHeight * density)
            if (!width || !height) return
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; blank = false }

            if (loudest < SILENT) {
                if (!blank) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height) }
                blank = true
                return
            }
            blank = false
            ctx.setTransform(1, 0, 0, 1, 0, 0)
            ctx.clearRect(0, 0, width, height)
            ctx.setTransform(width / BOX.w, 0, 0, height / BOX.h, 0, 0)

            const { style, height: tallest, color, opacity } = look.current
            ctx.globalAlpha = Math.min(Math.max(opacity / 100, 0), 1)
            const channels = rgb(ctx, color)
            const slotWidth = BOX.w / levels.length
            const reach = tallest / 100 * SCREEN // how far the loudest line rises, in canvas units

            // Where each line stands and reaches: its foot below the skyline there, its tip that far above its foot
            const lines = Array.from(levels, (level, slot) => {
                const x = (slot + 0.5) * slotWidth
                const base = skylineAt(x) + BELOW
                return { x, base, top: base - level * reach }
            })

            if (style === 'bars') {
                const barWidth = slotWidth * 0.26
                const radius = barWidth / 2
                lines.forEach(({ x, base, top }) => {
                    if (base - top < 1) return
                    // Each line fades in from its own foot, so it seems to climb out of the mountains
                    const gradient = ctx.createLinearGradient(0, base, 0, top)
                    gradient.addColorStop(0, `rgba(${channels}, 0)`)
                    gradient.addColorStop(FADE, `rgba(${channels}, 0.6)`)
                    gradient.addColorStop(1, `rgba(${channels}, 0.95)`)
                    ctx.fillStyle = gradient
                    ctx.beginPath()
                    ctx.roundRect(x - barWidth / 2, top, barWidth, base - top + radius, [radius, radius, 0, 0])
                    ctx.fill()
                })
            } else {
                // A smooth line through the tips, curving through the midpoints between them
                const tips: [number, number][] = lines.map(({ x, top }) => [x, top])
                tips.unshift([0, tips[0][1]])
                tips.push([BOX.w, tips[tips.length - 1][1]])
                ctx.beginPath()
                ctx.moveTo(tips[0][0], tips[0][1])
                for (let i = 1; i < tips.length - 1; i++) {
                    const [x, y] = tips[i], [nextX, nextY] = tips[i + 1]
                    ctx.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2)
                }
                ctx.lineTo(BOX.w, tips[tips.length - 1][1])

                ctx.lineWidth = 6
                ctx.strokeStyle = `rgba(${channels}, 0.9)`
                ctx.stroke()

                // Closed back along the feet, so what's filled sits against the skyline rather than over the whole sky
                for (let slot = levels.length - 1; slot >= 0; slot--) ctx.lineTo(lines[slot].x, lines[slot].base)
                ctx.lineTo(0, lines[0].base)
                ctx.closePath()
                const gradient = ctx.createLinearGradient(0, Math.min(...tips.map(([, y]) => y)), 0, BOX.h)
                gradient.addColorStop(0, `rgba(${channels}, 0.5)`)
                gradient.addColorStop(1, `rgba(${channels}, 0)`)
                ctx.fillStyle = gradient
                ctx.fill()
            }
        }

        frame = requestAnimationFrame(draw)
        return () => {
            cancelAnimationFrame(frame)
            ctx.setTransform(1, 0, 0, 1, 0, 0)
            ctx.clearRect(0, 0, canvas.width, canvas.height)
        }
    }, [visualizer, paused])

    if (!visualizer) return null
    return (
        <ArtCanvas>
            <Piece box={BOX}>
                <canvas ref={canvasRef} className={styles.canvas} />
            </Piece>
        </ArtCanvas>
    )
}
