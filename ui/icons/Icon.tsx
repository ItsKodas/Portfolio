import type { ReactNode } from 'react'

export type IconProps = {
    size?: number
    title?: string
}

// One wrapper, so every icon is the same size, takes its colour from the text, and is invisible to a screen
// reader unless it is the only thing carrying the meaning.
export function Icon({ size = 20, title, children }: IconProps & { children: ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            role={title ? 'img' : undefined}
            aria-hidden={title ? undefined : 'true'}
            aria-label={title}
            focusable="false"
        >
            {children}
        </svg>
    )
}
