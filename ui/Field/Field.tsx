'use client'

import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'

import styles from './Field.module.css'

// Everything an input takes, plus the three attributes only a textarea has, so `as="textarea"` can be given
// a height. Picking those three rather than intersecting the two attribute sets keeps value and onChange
// typed for an input, which is what almost every Field is. id is ours: the label has to point at it.
type TextareaOnly = Pick<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'cols' | 'wrap'>

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & TextareaOnly & {
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
