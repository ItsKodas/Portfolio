'use client'

// Visits and unique visitors per day, as two lines on one axis (both are counts of the same kind, so one
// scale is honest). A client component only for the hover: the crosshair and the tooltip follow the
// pointer, and the arrow keys move them for a keyboard. The same numbers are in the table under it.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import type { AnalyticsDay } from '@/server/hostd/analytics'
import { count, dayLabel, scaleFor } from './analyticsView'
import styles from './analytics.module.css'

const HEIGHT = 150
const PAD = { top: 8, right: 12, bottom: 22, left: 40 }

type Props = {
    days: AnalyticsDay[]
    // The first day anything was counted. The lines start there rather than drawing a flat zero for days
    // before the site was being counted at all.
    since: string | null
}

function pathOf(points: Array<[number, number]>): string {
    return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
}

export function AnalyticsChart({ days, since }: Props) {
    const frame = useRef<HTMLDivElement>(null)
    const [width, setWidth] = useState(640)
    const [active, setActive] = useState<number | null>(null)

    useEffect(() => {
        const element = frame.current
        if (!element) return
        const observer = new ResizeObserver(([entry]) => {
            if (entry) setWidth(Math.max(280, Math.round(entry.contentRect.width)))
        })
        observer.observe(element)
        return () => observer.disconnect()
    }, [])

    const { top, ticks } = scaleFor(Math.max(0, ...days.map(day => day.views)))
    const plotWidth = width - PAD.left - PAD.right
    const plotHeight = HEIGHT - PAD.top - PAD.bottom
    const step = days.length > 1 ? plotWidth / (days.length - 1) : 0
    const xAt = (index: number) => PAD.left + index * step
    const yAt = (value: number) => PAD.top + plotHeight - (value / top) * plotHeight

    const first = since === null ? days.length : Math.max(0, days.findIndex(day => day.date >= since))
    const counted = first === -1 ? [] : days.map((day, index) => ({ day, index })).slice(first)
    const views = pathOf(counted.map(({ day, index }) => [xAt(index), yAt(day.views)]))
    const visitors = pathOf(counted.map(({ day, index }) => [xAt(index), yAt(day.visitors)]))
    const area = counted.length > 1
        ? `${views}L${xAt(counted.at(-1)!.index).toFixed(1)},${yAt(0)}L${xAt(counted[0]!.index).toFixed(1)},${yAt(0)}Z`
        : ''

    // A date under the first and last day and a few between, never so many they collide
    const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotWidth / 70))))
    const labelled = days.map((_, index) => index).filter(index => index === days.length - 1 || (index % labelEvery === 0 && days.length - 1 - index >= labelEvery))

    const nearest = (clientX: number) => {
        const box = frame.current?.getBoundingClientRect()
        if (!box || days.length === 0) return null
        const index = Math.round((clientX - box.left - PAD.left) / (step || 1))
        return Math.min(days.length - 1, Math.max(0, index))
    }
    const onPointer = (event: PointerEvent) => setActive(nearest(event.clientX))
    const onKey = (event: KeyboardEvent) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        setActive(current => {
            const from = current ?? days.length - 1
            return Math.min(days.length - 1, Math.max(0, from + (event.key === 'ArrowLeft' ? -1 : 1)))
        })
    }

    const shown = active === null ? null : days[active]
    const beforeCounting = shown && since !== null && shown.date < since

    return (
        <div className={styles.chart} ref={frame}>
            <svg
                width={width}
                height={HEIGHT}
                role="img"
                aria-label={`Visits and unique visitors per day, ${days.length} days. Use the arrow keys to read each day.`}
                tabIndex={0}
                onPointerMove={onPointer}
                onPointerDown={onPointer}
                onPointerLeave={() => setActive(null)}
                onKeyDown={onKey}
                onBlur={() => setActive(null)}
            >
                {ticks.map(tick => (
                    <g key={tick}>
                        <line className={styles.grid} x1={PAD.left} x2={width - PAD.right} y1={yAt(tick)} y2={yAt(tick)} />
                        <text className={styles.axis} x={PAD.left - 8} y={yAt(tick)} dy="0.32em" textAnchor="end">{count(tick)}</text>
                    </g>
                ))}
                {labelled.map(index => (
                    <text
                        key={index}
                        className={styles.axis}
                        x={xAt(index)}
                        y={HEIGHT - 6}
                        textAnchor={index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'}
                    >
                        {dayLabel(days[index]!.date)}
                    </text>
                ))}

                {area && <path className={styles.area} d={area} />}
                <path className={styles.views} d={views} />
                <path className={styles.visitors} d={visitors} />

                {shown && active !== null && (
                    <g>
                        <line className={styles.cross} x1={xAt(active)} x2={xAt(active)} y1={PAD.top} y2={PAD.top + plotHeight} />
                        {!beforeCounting && (
                            <>
                                <circle className={styles.dotViews} cx={xAt(active)} cy={yAt(shown.views)} r={4} />
                                <circle className={styles.dotVisitors} cx={xAt(active)} cy={yAt(shown.visitors)} r={4} />
                            </>
                        )}
                    </g>
                )}
            </svg>

            {shown && active !== null && (
                <div
                    className={styles.tip}
                    role="status"
                    // Beside the crosshair rather than over it, on whichever side has the room, so the
                    // tooltip never sits on the day it is describing
                    style={xAt(active) > width / 2
                        ? { right: width - xAt(active) + 12 }
                        : { left: xAt(active) + 12 }}
                >
                    <p className={styles.tipDate}>{dayLabel(shown.date, 'long')}</p>
                    {beforeCounting
                        ? <p className={styles.tipRow}>Not counted yet</p>
                        : (
                            <>
                                <p className={styles.tipRow}><span className={styles.keyViews} aria-hidden />Visits <b>{count(shown.views)}</b></p>
                                <p className={styles.tipRow}><span className={styles.keyVisitors} aria-hidden />Unique visitors <b>{count(shown.visitors)}</b></p>
                            </>
                        )}
                </div>
            )}
        </div>
    )
}
