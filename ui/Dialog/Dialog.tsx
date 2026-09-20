'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'

import { Button } from '../Button/Button'
import styles from './Dialog.module.css'

type Props = {
    open: boolean
    onClose: () => void
    title: string
    children: ReactNode
    footer?: ReactNode
}

export function Dialog({ open, onClose, title, children, footer }: Props) {
    const ref = useRef<HTMLDialogElement>(null)
    const titleId = useId()

    useEffect(() => {
        if (!open) return
        const dialog = ref.current
        if (!dialog) return

        // Whoever opened it, captured before showModal moves focus into the dialog. The platform returns
        // focus by itself when a dialog is close()d and left in the page, but this one unmounts instead
        // (see the `return null` below), and a dialog removed from the DOM while open drops focus to the
        // body. Checked in a browser, both ways round, because jsdom cannot show it either way.
        const opener = document.activeElement as HTMLElement | null

        // showModal is what gives focus trapping, the top layer and inertness of the rest of the page.
        // Opening with the open attribute instead gets none of those.
        if (!dialog.open) dialog.showModal()

        return () => {
            if (dialog.open) dialog.close()
            opener?.focus()
        }
    }, [open])

    if (!open) return null

    return (
        <dialog
            ref={ref}
            className={styles.dialog}
            aria-labelledby={titleId}
            // The platform fires cancel for Escape and close when the dialog closes by any route
            onCancel={event => { event.preventDefault(); onClose() }}
            onClose={onClose}
        >
            <div className={styles.head}>
                <h2 className={styles.title} id={titleId}>{title}</h2>
                <Button variant="quiet" size="small" className={styles.close} aria-label="Close" onClick={onClose}>&times;</Button>
            </div>
            <div className={styles.body}>{children}</div>
            {footer && <div className={styles.footer}>{footer}</div>}
        </dialog>
    )
}
