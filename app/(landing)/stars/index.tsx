'use client'

import { useEffect, useRef } from 'react'

interface Star {
    angle: number
    dist: number
    r: number
    baseOpacity: number
    twinkleSpeed: number
    twinklePhase: number
}

interface Moon {
    x: number
    y: number
}

const ROTATION_SPEED = 0.000025
const MOON_SPEED     = 0.003
const MOON_R         = 28

export default function RotatingStars() {
    const canvasRef = useRef<HTMLCanvasElement>(null)

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        let animId: number
        let w = canvas.offsetWidth
        let h = canvas.offsetHeight
        canvas.width = w
        canvas.height = h

        // ── Offscreen crescent ────────────────────────────────────────────────
        const PAD   = MOON_R * 5
        const SIZE  = PAD * 2
        const oc    = PAD // centre inside offscreen canvas

        const offCanvas = document.createElement('canvas')
        offCanvas.width  = SIZE
        offCanvas.height = SIZE
        const offCtx = offCanvas.getContext('2d')!

        const buildMoonCanvas = () => {
            offCtx.clearRect(0, 0, SIZE, SIZE)

            // Full disc with radial gradient (bright top-left → blue limb)
            const disc = offCtx.createRadialGradient(
                oc - MOON_R * 0.3, oc - MOON_R * 0.3, 0,
                oc, oc, MOON_R
            )
            disc.addColorStop(0,   'rgba(245,250,255,1)')
            disc.addColorStop(0.5, 'rgba(215,235,252,0.95)')
            disc.addColorStop(1,   'rgba(170,205,240,0.85)')
            offCtx.beginPath()
            offCtx.arc(oc, oc, MOON_R, 0, Math.PI * 2)
            offCtx.fillStyle = disc
            offCtx.fill()

            // Subtract shadow circle to leave crescent sliver on the left
            offCtx.globalCompositeOperation = 'destination-out'
            offCtx.beginPath()
            offCtx.arc(oc + MOON_R * 0.52, oc - MOON_R * 0.05, MOON_R * 0.93, 0, Math.PI * 2)
            offCtx.fillStyle = 'rgba(0,0,0,1)'
            offCtx.fill()
            offCtx.globalCompositeOperation = 'source-over'
        }

        buildMoonCanvas()

        // ── Stars ─────────────────────────────────────────────────────────────
        const buildStars = (): Star[] => {
            const cx = w / 2
            const cy = h / 2
            const maxDist = Math.sqrt(cx * cx + cy * cy) * 1.05
            return Array.from({ length: 400 }, () => {
                const layer = Math.floor(Math.random() * 3)
                return {
                    angle:        Math.random() * Math.PI * 2,
                    dist:         maxDist * Math.sqrt(Math.random()),
                    r:            [0.6, 1.1, 2.0][layer],
                    baseOpacity:  [0.55, 0.8, 1.0][layer],
                    twinkleSpeed: 0.5 + Math.random() * 2.0,
                    twinklePhase: Math.random() * Math.PI * 2,
                }
            })
        }

        let stars = buildStars()

        const moon: Moon = {
            x: Math.random() * w,
            y: h * (0.12 + Math.random() * 0.10),
        }

        // ── Draw moon ─────────────────────────────────────────────────────────
        const drawMoon = (x: number, y: number) => {
            // Soft atmosphere glow
            const atmo = ctx.createRadialGradient(x, y, MOON_R * 0.9, x, y, MOON_R * 4.5)
            atmo.addColorStop(0, 'rgba(200,228,255,0.22)')
            atmo.addColorStop(1, 'rgba(200,228,255,0)')
            ctx.beginPath()
            ctx.arc(x, y, MOON_R * 4.5, 0, Math.PI * 2)
            ctx.fillStyle = atmo
            ctx.fill()

            // Stamp crescent from offscreen canvas
            ctx.drawImage(offCanvas, x - oc, y - oc)
        }

        let lastTs = 0

        const frame = (ts: number) => {
            const dt = ts - lastTs
            lastTs = ts

            ctx.clearRect(0, 0, w, h)

            const cx = w / 2
            const cy = h / 2
            const t  = ts * 0.001

            moon.x -= MOON_SPEED * dt
            if (moon.x < -MOON_R * 6) moon.x = w + MOON_R * 6

            drawMoon(moon.x, moon.y)

            for (const star of stars) {
                star.angle += ROTATION_SPEED * dt

                const x = cx + Math.cos(star.angle) * star.dist
                const y = cy + Math.sin(star.angle) * star.dist

                if (x < -4 || x > w + 4 || y < -4 || y > h + 4) continue

                const twinkle = 0.55 + 0.45 * Math.sin(t * star.twinkleSpeed + star.twinklePhase)
                const alpha   = star.baseOpacity * twinkle

                if (star.r >= 2.0) {
                    const g = ctx.createRadialGradient(x, y, 0, x, y, star.r * 5)
                    g.addColorStop(0, `rgba(200,230,255,${alpha * 0.5})`)
                    g.addColorStop(1, 'rgba(200,230,255,0)')
                    ctx.beginPath()
                    ctx.arc(x, y, star.r * 5, 0, Math.PI * 2)
                    ctx.fillStyle = g
                    ctx.fill()
                }

                ctx.beginPath()
                ctx.arc(x, y, star.r, 0, Math.PI * 2)
                ctx.fillStyle = `rgba(220,240,255,${alpha})`
                ctx.fill()
            }

            animId = requestAnimationFrame(frame)
        }

        animId = requestAnimationFrame(frame)

        const onResize = () => {
            w = canvas.offsetWidth
            h = canvas.offsetHeight
            canvas.width = w
            canvas.height = h
            stars = buildStars()
            moon.y = h * (0.12 + Math.random() * 0.10)
        }
        window.addEventListener('resize', onResize)

        return () => {
            cancelAnimationFrame(animId)
            window.removeEventListener('resize', onResize)
        }
    }, [])

    return (
        <canvas
            ref={canvasRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        />
    )
}
