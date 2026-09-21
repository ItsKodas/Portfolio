import type { ButtonHTMLAttributes } from 'react'

import styles from './Button.module.css'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'quiet' | 'danger'
    size?: 'small' | 'medium'
}

export function Button({ variant, size, className, type, ...rest }: Props) {
    const classes = [styles.button, variant && styles[variant], size === 'small' && styles.small, className]
        .filter(Boolean)
        .join(' ')
    // A button with no type submits the form it sits in, which has surprised everyone at least once.
    return <button type={type ?? 'button'} className={classes} {...rest} />
}
