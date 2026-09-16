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

const ROTATION_SPEED = 0.000025
const GLOW_SPRITE_R  = 32

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

        // Prerendered star glow, stamped with drawImage instead of a new gradient per star per frame
        const glow = document.createElement('canvas')
        glow.width = glow.height = GLOW_SPRITE_R * 2
        const glowCtx = glow.getContext('2d')!
        const glowGrad = glowCtx.createRadialGradient(GLOW_SPRITE_R, GLOW_SPRITE_R, 0, GLOW_SPRITE_R, GLOW_SPRITE_R, GLOW_SPRITE_R)
        glowGrad.addColorStop(0, 'rgba(200,230,255,0.5)')
        glowGrad.addColorStop(1, 'rgba(200,230,255,0)')
        glowCtx.fillStyle = glowGrad
        glowCtx.fillRect(0, 0, glow.width, glow.height)

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

        let lastTs = 0
        let running = false

        const frame = (ts: number) => {
            const dt = lastTs ? Math.min(ts - lastTs, 50) : 0
            lastTs = ts

            ctx.clearRect(0, 0, w, h)

            const cx = w / 2
            const cy = h / 2
            const t  = ts * 0.001

            ctx.fillStyle = 'rgb(220,240,255)'

            for (const star of stars) {
                star.angle += ROTATION_SPEED * dt

                const x = cx + Math.cos(star.angle) * star.dist
                const y = cy + Math.sin(star.angle) * star.dist

                if (x < -4 || x > w + 4 || y < -4 || y > h + 4) continue

                const twinkle = 0.55 + 0.45 * Math.sin(t * star.twinkleSpeed + star.twinklePhase)
                const alpha   = star.baseOpacity * twinkle

                ctx.globalAlpha = alpha

                if (star.r >= 2.0) {
                    const gr = star.r * 5
                    ctx.drawImage(glow, x - gr, y - gr, gr * 2, gr * 2)
                }

                ctx.beginPath()
                ctx.arc(x, y, star.r, 0, Math.PI * 2)
                ctx.fill()
            }
            ctx.globalAlpha = 1

            if (running) animId = requestAnimationFrame(frame)
        }

        // Only animate while the hero is on screen (the canvas itself extends behind the content)
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting && !running) {
                running = true
                lastTs = 0
                animId = requestAnimationFrame(frame)
            } else if (!entry.isIntersecting) {
                running = false
                cancelAnimationFrame(animId)
            }
        })
        observer.observe(canvas.closest('section') ?? canvas)

        const onResize = () => {
            w = canvas.offsetWidth
            h = canvas.offsetHeight
            canvas.width = w
            canvas.height = h
            stars = buildStars()
        }
        window.addEventListener('resize', onResize)

        return () => {
            running = false
            cancelAnimationFrame(animId)
            observer.disconnect()
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
