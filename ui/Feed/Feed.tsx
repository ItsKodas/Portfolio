import type { ReactNode } from 'react'

import styles from './Feed.module.css'

type Event = {
    time: string
    text: ReactNode
    bad?: boolean
}

export function Feed({ events }: { events: Event[] }) {
    return (
        <ul className={styles.feed}>
            {events.map((event, index) => (
                <li className={[styles.event, event.bad && styles.bad].filter(Boolean).join(' ')} key={index}>
                    <time className={styles.time}>{event.time}</time>
                    <span className={styles.text}>{event.text}</span>
                </li>
            ))}
        </ul>
    )
}
