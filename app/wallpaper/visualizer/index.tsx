'use client'

// The sound playing on the computer, drawn along the bottom of the screen over the trees: the left channel on the left
// and the right channel mirrored on the right, bass at the outside edges rising in towards the treble in the middle.
// From Wallpaper Engine's audio listener (see mediaScript.ts), so only in Wallpaper Engine; elsewhere nothing's drawn and
// nothing runs. As bars, or a smooth wave, in white or the colour of the album art that's playing.

import { useEffect, useRef } from 'react'

import { useNowPlaying } from '../media'
import { useSettings } from '../settings'
import styles from './visualizer.module.css'

const BARS_PER_SIDE = 32   // each from a pair of the 64 levels a channel comes in
const RISE = 0.55          // how much of the way up to a louder level a bar goes each frame
const FALL = 0.9           // and how much of its height it keeps each frame as it falls back
const SILENT = 0.002       // below this everything counts as silent, and nothing's drawn
const LIFT = 0.7           // levels are raised to this power, lifting the quieter ones (they mostly sit well below 1)

// A CSS colour as its red, green and blue, by way of a canvas (which normalises any colour to #rrggbb)
function rgb(ctx: CanvasRenderingContext2D, color: string) {
    ctx.fillStyle = '#ffffff'
    ctx.fillStyle = color
    const hex = String(ctx.fillStyle)
    const n = parseInt(hex.slice(1), 16)
    return hex.startsWith('#') && hex.length === 7 ? `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}` : '255, 255, 255'
}

// (overscan: how much the scene it's placed in is scaled up, which it undoes, so it spans the screen exactly)
export default function Visualizer({ overscan }: { overscan: number }) {
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
                // The left channel's bars run in from the left edge, the right channel's in from the right edge
                const right = slot >= BARS_PER_SIDE
                const bar = right ? levels.length - 1 - slot : slot
                const first = (right ? 64 : 0) + bar * 2
                const target = audio ? Math.min(1, ((audio[first] ?? 0) + (audio[first + 1] ?? 0)) / 2) ** LIFT : 0
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
                const gradient = ctx.createLinearGradient(0, 0, 0, height)
                gradient.addColorStop(0, `rgba(${channels}, 0.95)`)
                gradient.addColorStop(1, `rgba(${channels}, 0.5)`)
                ctx.fillStyle = gradient
                const barWidth = slotWidth * 0.56
                const radius = Math.min(barWidth / 2, 6 * scale)
                ctx.beginPath()
                levels.forEach((level, slot) => {
                    const barHeight = level * height
                    if (barHeight < 1) return
                    const x = slot * slotWidth + (slotWidth - barWidth) / 2
                    ctx.roundRect(x, height - barHeight, barWidth, barHeight + radius, [radius, radius, 0, 0])
                })
                ctx.fill()
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
                gradient.addColorStop(0, `rgba(${channels}, 0.55)`)
                gradient.addColorStop(1, `rgba(${channels}, 0.12)`)
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
        <div className={styles.screen} style={{ transform: `scale(${1 / overscan})`, transformOrigin: '50% 50svh' }}>
            <canvas ref={canvasRef} className={styles.canvas} style={{ height: `${visualizerHeight}%` }} />
        </div>
    )
}
