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

// Radians per millisecond — one full rotation every ~4 minutes
const ROTATION_SPEED = 0.000025

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

        const buildStars = (): Star[] => {
            const cx = w / 2
            const cy = h / 2
            // Disc radius reaches every corner so stars cover all edges during rotation
            const maxDist = Math.sqrt(cx * cx + cy * cy) * 1.05
            return Array.from({ length: 400 }, () => {
                const layer = Math.floor(Math.random() * 3)
                return {
                    angle:        Math.random() * Math.PI * 2,
                    dist:         maxDist * Math.sqrt(Math.random()), // uniform area distribution
                    r:            [0.6, 1.1, 2.0][layer],
                    baseOpacity:  [0.55, 0.8, 1.0][layer],
                    twinkleSpeed: 0.5 + Math.random() * 2.0,
                    twinklePhase: Math.random() * Math.PI * 2,
                }
            })
        }

        let stars = buildStars()
        let lastTs = 0

        const frame = (ts: number) => {
            const dt = ts - lastTs
            lastTs = ts

            ctx.clearRect(0, 0, w, h)

            const cx = w / 2
            const cy = h / 2
            const t = ts * 0.001

            for (const star of stars) {
                star.angle += ROTATION_SPEED * dt

                const x = cx + Math.cos(star.angle) * star.dist
                const y = cy + Math.sin(star.angle) * star.dist

                if (x < -4 || x > w + 4 || y < -4 || y > h + 4) continue

                const twinkle = 0.55 + 0.45 * Math.sin(t * star.twinkleSpeed + star.twinklePhase)
                const alpha = star.baseOpacity * twinkle

                // Glow halo for bright stars
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
