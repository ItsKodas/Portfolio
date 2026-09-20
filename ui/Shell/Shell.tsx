'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

import styles from './Shell.module.css'

type Props = {
    brand: ReactNode
    bar?: ReactNode
    nav: ReactNode
    rail?: ReactNode
    children: ReactNode
}

export function Shell({ brand, bar, nav, rail, children }: Props) {
    const [open, setOpen] = useState(false)
    const menuRef = useRef<HTMLButtonElement>(null)
    const navRef = useRef<HTMLElement>(null)

    function close() {
        setOpen(false)
        menuRef.current?.focus()
    }

    useEffect(() => {
        if (!open) return
        // Focus the first thing in the drawer, so a keyboard lands inside what it just opened
        const first = navRef.current?.querySelector<HTMLElement>('button, a')
        if (first) first.focus()

        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape') close()
        }
        // A drawer left open while the window grows back would strand the scrim over three zones
        function onResize() {
            if (window.innerWidth > 760) setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onResize)
        return () => {
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('resize', onResize)
        }
    }, [open])

    return (
        <>
            <header className={styles.bar}>
                <button
                    ref={menuRef}
                    type="button"
                    className={styles.menu}
                    aria-label="Open the site list"
                    aria-expanded={open}
                    onClick={() => (open ? close() : setOpen(true))}
                >
                    &#9776;
                </button>
                <span className={styles.brand}>{brand}</span>
                {bar && <span className={styles.barExtra}>{bar}</span>}
            </header>

            <div className={styles.shell}>
                <nav
                    ref={navRef}
                    className={[styles.nav, open && styles.open].filter(Boolean).join(' ')}
                    // Anything chosen in here has served its purpose, so the drawer closes behind it
                    onClick={event => { if ((event.target as HTMLElement).closest('button, a')) close() }}
                >
                    {nav}
                </nav>
                <main className={styles.main}>{children}</main>
                {rail && <aside className={styles.rail}>{rail}</aside>}
            </div>

            {open && <div className={styles.scrim} onClick={close} />}
        </>
    )
}
