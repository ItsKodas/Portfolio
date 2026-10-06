'use client'

// When automatic copies are made and how many are kept. The time is Brisbane's, which hostd keeps the
// schedule in because it has no daylight saving: no copy is ever skipped or made twice when the clocks
// change elsewhere. hostd clamps the keep counts to what the operator allows this site and answers with
// what it saved, which is what the form shows afterwards.

import { useState } from 'react'

import type { Schedule, ScheduleMode } from '@/server/hostd/backups'
import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Field } from '@/ui/Field/Field'
import { saveScheduleAction } from './actions'
import { describeKeep, describeSchedule, timeOfDay, WEEKDAY_NAMES } from './backupView'
import styles from './site.module.css'

// Every half hour is plenty for a nightly copy, and a short list is easier to pick from than a clock
const TIMES = Array.from({ length: 48 }, (_, slot) => ({ hour: Math.floor(slot / 2), minute: (slot % 2) * 30 }))

const MODES: { value: ScheduleMode, label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'daily', label: 'Every day' },
    { value: 'weekly', label: 'Once a week' },
]

// A count box's text, read back as a whole number or null while it is not one
function count(text: string): number | null {
    if (!/^\d{1,4}$/.test(text.trim())) return null
    return Number(text.trim())
}

type Said = { ok: true, message: string } | { ok: false, error: string }

export function ScheduleForm({ id, schedule }: { id: string, schedule: Schedule }) {
    const [saved, setSaved] = useState(schedule)
    const [mode, setMode] = useState<ScheduleMode>(schedule.mode)
    const [time, setTime] = useState(`${schedule.hour}:${schedule.minute}`)
    const [weekday, setWeekday] = useState(schedule.weekday)
    const [daily, setDaily] = useState(String(schedule.keep.daily))
    const [weekly, setWeekly] = useState(String(schedule.keep.weekly))
    const [monthly, setMonthly] = useState(String(schedule.keep.monthly))
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<Said | null>(null)

    const [hour, minute] = time.split(':').map(Number)
    const keep = { daily: count(daily), weekly: count(weekly), monthly: count(monthly) }
    const keepValid = Object.values(keep).every(value => value !== null)
    // A time that is not on the half hour (set some other way) is still offered, so the form never shows
    // a value it cannot hold
    const times = TIMES.some(slot => slot.hour === saved.hour && slot.minute === saved.minute)
        ? TIMES
        : [...TIMES, { hour: saved.hour, minute: saved.minute }].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))

    async function save() {
        if (mode !== 'off' && !keepValid) return
        // Switched off with a count box left half typed: the saved counts stand, since nothing reads them
        // until the schedule is on again
        const asked = keep.daily !== null && keep.weekly !== null && keep.monthly !== null
            ? { daily: keep.daily, weekly: keep.weekly, monthly: keep.monthly }
            : saved.keep
        setPending(true)
        setSaid(null)
        try {
            const result = await saveScheduleAction(id, { mode, hour, minute, weekday, keep: asked })
            if (result.ok) {
                const next = result.schedule
                setSaved(next)
                setMode(next.mode)
                setTime(`${next.hour}:${next.minute}`)
                setWeekday(next.weekday)
                setDaily(String(next.keep.daily))
                setWeekly(String(next.keep.weekly))
                setMonthly(String(next.keep.monthly))
                setSaid({ ok: true, message: result.message })
            } else {
                setSaid(result)
            }
        } catch {
            setSaid({ ok: false, error: 'That did not work. Try reloading the page.' })
        } finally {
            setPending(false)
        }
    }

    return (
        <>
            <p className={styles.note}>
                {describeSchedule(saved)}
                {saved.mode !== 'off' && ` ${describeKeep(saved)}`}
            </p>

            <div className={styles.schedule}>
                <Field as="select" label="Make a copy" value={mode} onChange={event => setMode(event.target.value as ScheduleMode)}>
                    {MODES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Field>

                {mode === 'weekly' && (
                    <Field as="select" label="On" value={String(weekday)} onChange={event => setWeekday(Number(event.target.value))}>
                        {WEEKDAY_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
                    </Field>
                )}

                {mode !== 'off' && (
                    <Field as="select" label="At" hint="Brisbane time" value={time} onChange={event => setTime(event.target.value)}>
                        {times.map(slot => (
                            <option key={`${slot.hour}:${slot.minute}`} value={`${slot.hour}:${slot.minute}`}>
                                {timeOfDay(slot.hour, slot.minute)}
                            </option>
                        ))}
                    </Field>
                )}
            </div>

            {mode !== 'off' && (
                <div className={styles.schedule}>
                    <Field label="Daily copies kept" inputMode="numeric" value={daily} onChange={event => setDaily(event.target.value)}
                        error={keep.daily === null ? 'A whole number' : undefined} />
                    <Field label="Weekly copies kept" inputMode="numeric" value={weekly} onChange={event => setWeekly(event.target.value)}
                        error={keep.weekly === null ? 'A whole number' : undefined} />
                    <Field label="Monthly copies kept" inputMode="numeric" value={monthly} onChange={event => setMonthly(event.target.value)}
                        error={keep.monthly === null ? 'A whole number' : undefined} />
                </div>
            )}

            <div className={styles.save}>
                <Button variant="primary" disabled={pending || (mode !== 'off' && !keepValid)} onClick={save}>
                    {pending ? 'Saving...' : 'Save schedule'}
                </Button>
                {said && (said.ok
                    ? <span className={styles.state}>{said.message}</span>
                    : <span className={styles.stateBad}>{said.error}</span>)}
            </div>
        </>
    )
}
