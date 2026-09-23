'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

import styles from './Shell.module.css'

type Props = {
    brand: ReactNode
    // Sits beside the brand, where bar sits at the far end: the places in the product, rather than the page's own controls
    tabs?: ReactNode
    bar?: ReactNode
    nav: ReactNode
    rail?: ReactNode
    // For a page that is one panel rather than a column of blocks: the content column becomes a flex
    // column, so the page's own panel can take the height left over instead of ending where its content
    // does. Opt-in, because it changes how margins between blocks collapse on the pages that are blocks.
    fill?: boolean
    children: ReactNode
}

export function Shell({ brand, tabs, bar, nav, rail, fill, children }: Props) {
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
            <div className={styles.frame}>
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
                    {tabs}
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
                    <main className={[styles.main, fill && styles.fill].filter(Boolean).join(' ')}>{children}</main>
                    {rail && <aside className={styles.rail}>{rail}</aside>}
                </div>
            </div>

            {open && <div className={styles.scrim} onClick={close} />}
        </>
    )
}
