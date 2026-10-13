'use client'

// The Tax page's two charts. Money in and money out per month as paired bars (one scale, both dollars), and
// the year's running profit as a line. Each measures the box it is given and draws to fit it, so on a desktop
// they share whatever height the frame leaves, and each has a hover tooltip that the arrow keys also move.
// Colours are --chart-1 (income) and --chart-2 (expenses), the pair the analytics chart already validated.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'

import { formatMoney } from '@/server/invoices/money'
import type { Month } from '@/server/tax/summary'
import styles from './tax.module.css'

const PAD = { top: 8, right: 8, bottom: 20, left: 52 }

function useSize<T extends HTMLElement>(): [RefObject<T>, { width: number, height: number }] {
    const ref = useRef<T>(null)
    const [size, setSize] = useState({ width: 600, height: 180 })
    useEffect(() => {
        const element = ref.current
        if (!element) return
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setSize({ width: Math.max(260, Math.round(entry.contentRect.width)), height: Math.max(120, Math.round(entry.contentRect.height)) })
        })
        observer.observe(element)
        return () => observer.disconnect()
    }, [])
    return [ref, size]
}

// Round steps that cover the range, zero always among them
export function niceScale(min: number, max: number): { low: number, high: number, ticks: number[] } {
    const lo = Math.min(0, min)
    const hi = Math.max(0, max)
    if (hi - lo <= 0) return { low: 0, high: 100_00, ticks: [0, 50_00, 100_00] }
    const rough = (hi - lo) / 4
    const power = 10 ** Math.floor(Math.log10(rough))
    const step = [1, 2, 2.5, 5, 10].map(factor => factor * power).find(candidate => candidate >= rough) ?? 10 * power
    const low = Math.floor(lo / step) * step
    const high = Math.ceil(hi / step) * step
    const ticks: number[] = []
    for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(Math.round(tick))
    return { low, high, ticks }
}

// "$12k" on an axis, where the cents of a tick are noise
export function axisMoney(cents: number): string {
    const dollars = cents / 100
    const abs = Math.abs(dollars)
    const sign = dollars < 0 ? '-' : ''
    if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}k`
    return `${sign}$${Math.round(abs)}`
}

function useHover(count: number) {
    const [active, setActive] = useState<number | null>(null)
    const onKey = (event: KeyboardEvent) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        setActive(index => Math.min(count - 1, Math.max(0, (index ?? count - 1) + (event.key === 'ArrowLeft' ? -1 : 1))))
    }
    return { active, setActive, onKey }
}

function Tip({ x, width, title, rows }: { x: number, width: number, title: string, rows: { key: string, swatch?: string, value: string }[] }) {
    return (
        <div className={styles.tip} role="status" style={x > width / 2 ? { right: width - x + 12 } : { left: x + 12 }}>
            <p className={styles.tipTitle}>{title}</p>
            {rows.map(row => (
                <p key={row.key} className={styles.tipRow}>
                    {row.swatch && <span className={styles[row.swatch]} aria-hidden />}
                    {row.key} <b>{row.value}</b>
                </p>
            ))}
        </div>
    )
}

export function MonthlyChart({ months }: { months: Month[] }) {
    const [ref, { width, height }] = useSize<HTMLDivElement>()
    const { active, setActive, onKey } = useHover(months.length)
    const { low, high, ticks } = niceScale(0, Math.max(...months.map(month => Math.max(month.incomeCents, month.expenseCents))))
    const plotWidth = width - PAD.left - PAD.right
    const plotHeight = height - PAD.top - PAD.bottom
    const band = plotWidth / months.length
    const bar = Math.max(3, Math.min(18, (band - 10) / 2))
    const yAt = (value: number) => PAD.top + plotHeight - ((value - low) / (high - low)) * plotHeight
    const xAt = (index: number) => PAD.left + band * index + band / 2

    const onPointer = (event: PointerEvent) => {
        const box = ref.current?.getBoundingClientRect()
        if (!box) return
        const index = Math.floor((event.clientX - box.left - PAD.left) / band)
        setActive(index >= 0 && index < months.length ? index : null)
    }
    const shown = active === null ? null : months[active]

    // A bar is drawn with rounded ends away from the baseline and a square end on it
    const column = (x: number, value: number, className: string) => {
        const top = yAt(value)
        const base = yAt(0)
        if (base - top < 0.5) return null
        const r = Math.min(3, bar / 2, base - top)
        return <path className={className} d={`M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bar - r}Q${x + bar},${top} ${x + bar},${top + r}V${base}Z`} />
    }

    return (
        <div className={styles.chart} ref={ref}>
            <svg
                width={width}
                height={height}
                role="img"
                aria-label="Income and expenses for each month of the financial year. Use the arrow keys to read each month."
                tabIndex={0}
                onPointerMove={onPointer}
                onPointerDown={onPointer}
                onPointerLeave={() => setActive(null)}
                onKeyDown={onKey}
                onBlur={() => setActive(null)}
            >
                {ticks.map(tick => (
                    <g key={tick}>
                        <line className={tick === 0 ? styles.base : styles.grid} x1={PAD.left} x2={width - PAD.right} y1={yAt(tick)} y2={yAt(tick)} />
                        <text className={styles.axis} x={PAD.left - 8} y={yAt(tick)} dy="0.32em" textAnchor="end">{axisMoney(tick)}</text>
                    </g>
                ))}
                {months.map((month, index) => (
                    <g key={month.month}>
                        {active === index && <rect className={styles.hoverBand} x={PAD.left + band * index} y={PAD.top} width={band} height={plotHeight} />}
                        {column(xAt(index) - bar - 1, month.incomeCents, styles.barIncome)}
                        {column(xAt(index) + 1, month.expenseCents, styles.barExpense)}
                        <text className={styles.axis} x={xAt(index)} y={height - 5} textAnchor="middle">{month.label}</text>
                    </g>
                ))}
            </svg>
            {shown && active !== null && (
                <Tip x={xAt(active)} width={width} title={`${shown.label} ${shown.month.slice(0, 4)}`} rows={[
                    { key: 'Income', swatch: 'keyIncome', value: formatMoney(shown.incomeCents) },
                    { key: 'Expenses', swatch: 'keyExpense', value: formatMoney(shown.expenseCents) },
                    { key: 'Profit', value: formatMoney(shown.incomeCents - shown.expenseCents) },
                ]} />
            )}
        </div>
    )
}

// The running total of profit through the year, drawn only as far as the months that have begun
export function ProfitChart({ months, through }: { months: Month[], through: number }) {
    const [ref, { width, height }] = useSize<HTMLDivElement>()
    const { active, setActive, onKey } = useHover(through)
    let running = 0
    const points = months.slice(0, through).map(month => (running += month.incomeCents - month.expenseCents))
    const { low, high, ticks } = niceScale(Math.min(0, ...points), Math.max(0, ...points))
    const plotWidth = width - PAD.left - PAD.right
    const plotHeight = height - PAD.top - PAD.bottom
    const band = plotWidth / months.length
    const xAt = (index: number) => PAD.left + band * index + band / 2
    const yAt = (value: number) => PAD.top + plotHeight - ((value - low) / (high - low)) * plotHeight
    const line = points.map((value, index) => `${index ? 'L' : 'M'}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`).join('')
    const area = points.length > 1 ? `${line}L${xAt(points.length - 1).toFixed(1)},${yAt(0)}L${xAt(0).toFixed(1)},${yAt(0)}Z` : ''

    const onPointer = (event: PointerEvent) => {
        const box = ref.current?.getBoundingClientRect()
        if (!box || !points.length) return
        const index = Math.floor((event.clientX - box.left - PAD.left) / band)
        setActive(Math.min(points.length - 1, Math.max(0, index)))
    }
    const shown = active === null ? null : points[active]

    return (
        <div className={styles.chart} ref={ref}>
            <svg
                width={width}
                height={height}
                role="img"
                aria-label="Profit so far this financial year, month by month. Use the arrow keys to read each month."
                tabIndex={0}
                onPointerMove={onPointer}
                onPointerDown={onPointer}
                onPointerLeave={() => setActive(null)}
                onKeyDown={onKey}
                onBlur={() => setActive(null)}
            >
                {ticks.map(tick => (
                    <g key={tick}>
                        <line className={tick === 0 ? styles.base : styles.grid} x1={PAD.left} x2={width - PAD.right} y1={yAt(tick)} y2={yAt(tick)} />
                        <text className={styles.axis} x={PAD.left - 8} y={yAt(tick)} dy="0.32em" textAnchor="end">{axisMoney(tick)}</text>
                    </g>
                ))}
                {months.map((month, index) => (
                    <text key={month.month} className={styles.axis} x={xAt(index)} y={height - 5} textAnchor="middle">{month.label}</text>
                ))}
                {area && <path className={styles.profitArea} d={area} />}
                {points.length > 0 && <path className={styles.profitLine} d={line} />}
                {points.length === 1 && <circle className={styles.profitDot} cx={xAt(0)} cy={yAt(points[0])} r={4} />}
                {shown !== null && active !== null && (
                    <g>
                        <line className={styles.cross} x1={xAt(active)} x2={xAt(active)} y1={PAD.top} y2={PAD.top + plotHeight} />
                        <circle className={styles.profitDot} cx={xAt(active)} cy={yAt(shown)} r={4} />
                    </g>
                )}
            </svg>
            {shown !== null && active !== null && (
                <Tip x={xAt(active)} width={width} title={`To the end of ${months[active].label}`} rows={[{ key: 'Profit so far', value: formatMoney(shown) }]} />
            )}
        </div>
    )
}
