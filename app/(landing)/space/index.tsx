'use client'

import { useEffect, useRef } from 'react'
import styles from './space.module.css'

interface Star {
    x: number
    y: number
    r: number
    baseOpacity: number
    twinkleSpeed: number
    twinklePhase: number
    glow: boolean
}

interface Shooter {
    active: boolean
    x: number
    y: number
    vx: number
    vy: number
    life: number
    maxLife: number
}

export default function SpaceBackground() {
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

        const buildStars = (): Star[] =>
            Array.from({ length: 380 }, () => {
                const layer = Math.floor(Math.random() * 4)
                return {
                    x: Math.random() * w,
                    y: Math.random() * h,
                    r: [0.25, 0.5, 0.85, 1.3][layer],
                    baseOpacity: [0.2, 0.4, 0.6, 0.9][layer],
                    twinkleSpeed: 0.4 + Math.random() * 1.6,
                    twinklePhase: Math.random() * Math.PI * 2,
                    glow: layer === 3
                }
            })

        let stars = buildStars()

        const shooters: Shooter[] = Array.from({ length: 4 }, () => ({
            active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0
        }))

        let nextShootAt = 2500 + Math.random() * 3000
        let elapsed = 0
        let lastTs = 0

        const spawnShooter = () => {
            const s = shooters.find(s => !s.active)
            if (!s) return
            const angle = Math.PI / 5 + (Math.random() - 0.5) * 0.5
            const speed = 9 + Math.random() * 10
            s.x = Math.random() * w * 0.65
            s.y = Math.random() * h * 0.35
            s.vx = Math.cos(angle) * speed
            s.vy = Math.sin(angle) * speed
            s.maxLife = 55 + Math.random() * 45
            s.life = 0
            s.active = true
        }

        const frame = (ts: number) => {
            const dt = ts - lastTs
            lastTs = ts
            elapsed += dt

            ctx.clearRect(0, 0, w, h)
            const t = ts * 0.001

            for (const star of stars) {
                const twinkle = 0.78 + 0.22 * Math.sin(t * star.twinkleSpeed + star.twinklePhase)
                const alpha = star.baseOpacity * twinkle

                ctx.beginPath()
                ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2)
                ctx.fillStyle = `rgba(255,255,255,${alpha})`
                ctx.fill()

                if (star.glow) {
                    const g = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, star.r * 4.5)
                    g.addColorStop(0, `rgba(190,230,255,${alpha * 0.35})`)
                    g.addColorStop(1, 'rgba(190,230,255,0)')
                    ctx.beginPath()
                    ctx.arc(star.x, star.y, star.r * 4.5, 0, Math.PI * 2)
                    ctx.fillStyle = g
                    ctx.fill()
                }
            }

            if (elapsed >= nextShootAt) {
                spawnShooter()
                nextShootAt = elapsed + 3000 + Math.random() * 5000
            }

            for (const s of shooters) {
                if (!s.active) continue
                s.life++
                if (s.life >= s.maxLife) { s.active = false; continue }

                const p = s.life / s.maxLife
                const alpha = p < 0.15 ? p / 0.15 : Math.max(0, 1 - (p - 0.15) / 0.85)
                const trailLen = 90 + (1 - p) * 80
                const speed = Math.sqrt(s.vx ** 2 + s.vy ** 2)
                const tailX = s.x - (s.vx / speed) * trailLen
                const tailY = s.y - (s.vy / speed) * trailLen

                const grad = ctx.createLinearGradient(tailX, tailY, s.x, s.y)
                grad.addColorStop(0, 'rgba(255,255,255,0)')
                grad.addColorStop(0.65, `rgba(200,240,255,${alpha * 0.35})`)
                grad.addColorStop(1, `rgba(255,255,255,${alpha})`)

                ctx.beginPath()
                ctx.moveTo(tailX, tailY)
                ctx.lineTo(s.x, s.y)
                ctx.strokeStyle = grad
                ctx.lineWidth = 1.5
                ctx.stroke()

                s.x += s.vx
                s.y += s.vy
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
        <div className={styles.wrap}>
            <canvas ref={canvasRef} className={styles.canvas} />
            <div className={`${styles.nebula} ${styles.n1}`} />
            <div className={`${styles.nebula} ${styles.n2}`} />
            <div className={`${styles.nebula} ${styles.n3}`} />
            <div className={`${styles.nebula} ${styles.n4}`} />
            <div className={`${styles.nebula} ${styles.n5}`} />
        </div>
    )
}
