'use client'

import { useId, type InputHTMLAttributes } from 'react'

import styles from './Field.module.css'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
    label: string
    hint?: string
    error?: string
    as?: 'input' | 'textarea'
}

export function Field({ label, hint, error, as = 'input', className, ...rest }: Props) {
    // useId rather than the name, so two fields with the same label on one page still get different ids
    const id = useId()
    const hintId = `${id}-hint`
    const errorId = `${id}-error`

    // Order matters: a screen reader reads the description in the order given, and the hint explains the
    // field while the error explains what went wrong with it.
    const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined

    const controlProps = {
        id,
        className: [styles.control, error && styles.invalid, className].filter(Boolean).join(' '),
        'aria-invalid': error ? true : false,
        'aria-describedby': describedBy,
        ...rest,
    }

    return (
        <div className={styles.field}>
            <label className={styles.label} htmlFor={id}>{label}</label>
            {as === 'textarea'
                ? <textarea {...(controlProps as object)} />
                : <input {...controlProps} />}
            {hint && <span className={styles.hint} id={hintId}>{hint}</span>}
            {error && <span className={styles.error} id={errorId}>{error}</span>}
        </div>
    )
}
