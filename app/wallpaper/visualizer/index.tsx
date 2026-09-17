'use client'

// The sound playing on the computer, rising out of the mountains: the left channel on the left and the right channel
// mirrored on the right, the bass in the middle running out to the treble at the edges (the loudest lines are then over
// the valley, where the skyline is lowest and there's sky for them to climb into). It's drawn behind the far
// mountains (see the scene's sound layer), starting well below the skyline, so the lines climb up out of the ridge, and
// each fades in from its base to its tip. From Wallpaper Engine's audio listener (see mediaScript.ts), so only in
// Wallpaper Engine; elsewhere nothing's drawn and nothing runs. As bars, or a smooth wave, in white or the colour of
// the album art that's playing.

import { useEffect, useRef } from 'react'

import { useNowPlaying } from '../media'
import { useSettings } from '../settings'
import styles from './visualizer.module.css'

const BARS_PER_SIDE = 12   // each from a share of the 64 levels a channel comes in
const HIGHEST_BIN = 44     // the levels above this are near enough always silent, so they're left out
const RISE = 0.55          // how much of the way up to a louder level a bar goes each frame
const FALL = 0.9           // and how much of its height it keeps each frame as it falls back
const SILENT = 0.002       // below this everything counts as silent, and nothing's drawn
const LIFT = 0.7           // levels are raised to this power, lifting the quieter ones (they mostly sit well below 1)
const BASE = 0.62          // where the lines stand, down the screen, far enough below the skyline to be hidden there
const FADE = 0.45          // the share of a line, from its base up, over which it fades in from nothing

// Which of a channel's levels each bar is the loudness of: the lowest few bins for the bass bar at the outside edge,
// widening towards the treble, which has less going on to show
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
    const { visualizer, visualizerStyle, visualizerHeight, visualizerColor, paused } = useSettings()
    const track = useNowPlaying()
    const color = (visualizerColor === 'album' && track?.color) || '#ffffff'

    // The latest look, for the drawing loop to pick up without restarting
    const look = useRef({ style: visualizerStyle, color })
    look.current = { style: visualizerStyle, color }

    const canvasRef = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        if (!visualizer || paused || !canvas || !ctx || !window.__wallpaperMedia?.audioSupported) return

        const levels = new Float32Array(BARS_PER_SIDE * 2) // left to right across the screen
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

            // Sized to the canvas as shown, at the screen's pixel density
            const scale = window.devicePixelRatio || 1
            const width = Math.round(canvas.clientWidth * scale), height = Math.round(canvas.clientHeight * scale)
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; blank = false }

            if (loudest < SILENT) {
                if (!blank) ctx.clearRect(0, 0, width, height)
                blank = true
                return
            }
            blank = false
            ctx.clearRect(0, 0, width, height)

            const { style, color } = look.current
            const channels = rgb(ctx, color)
            const slotWidth = width / levels.length

            if (style === 'bars') {
                const barWidth = slotWidth * 0.26
                const radius = Math.min(barWidth / 2, 6 * scale)
                levels.forEach((level, slot) => {
                    const barHeight = level * height
                    if (barHeight < 1) return
                    const x = slot * slotWidth + (slotWidth - barWidth) / 2
                    // Each line fades in from its own base, so it seems to climb out of the mountains
                    const gradient = ctx.createLinearGradient(0, height, 0, height - barHeight)
                    gradient.addColorStop(0, `rgba(${channels}, 0)`)
                    gradient.addColorStop(Math.min(FADE, 1), `rgba(${channels}, 0.5)`)
                    gradient.addColorStop(1, `rgba(${channels}, 0.95)`)
                    ctx.fillStyle = gradient
                    ctx.beginPath()
                    ctx.roundRect(x, height - barHeight, barWidth, barHeight + radius, [radius, radius, 0, 0])
                    ctx.fill()
                })
            } else {
                // A smooth line through the top of each slot, curving through the midpoints between them, filled below
                const points = Array.from(levels, (level, slot) => [(slot + 0.5) * slotWidth, height - level * height])
                points.unshift([0, points[0][1]])
                points.push([width, points[points.length - 1][1]])
                ctx.beginPath()
                ctx.moveTo(points[0][0], points[0][1])
                for (let i = 1; i < points.length - 1; i++) {
                    const [x, y] = points[i], [nextX, nextY] = points[i + 1]
                    ctx.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2)
                }
                ctx.lineTo(width, points[points.length - 1][1])

                ctx.lineWidth = 2 * scale
                ctx.strokeStyle = `rgba(${channels}, 0.9)`
                ctx.stroke()

                ctx.lineTo(width, height)
                ctx.lineTo(0, height)
                ctx.closePath()
                const gradient = ctx.createLinearGradient(0, 0, 0, height)
                gradient.addColorStop(0, `rgba(${channels}, 0.5)`)
                gradient.addColorStop(1, `rgba(${channels}, 0)`)
                ctx.fillStyle = gradient
                ctx.fill()
            }
        }

        frame = requestAnimationFrame(draw)
        return () => {
            cancelAnimationFrame(frame)
            ctx.clearRect(0, 0, canvas.width, canvas.height)
        }
    }, [visualizer, paused])

    if (!visualizer) return null
    return (
        <div className={styles.screen}>
            <canvas ref={canvasRef} className={styles.canvas}
                style={{ height: `${visualizerHeight}%`, bottom: `${(1 - BASE) * 100}%` }} />
        </div>
    )
}
