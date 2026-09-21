import type { ReactNode } from 'react'

export type IconProps = {
    size?: number
    title?: string
    // The landing page hangs Tailwind hover transitions off its icons, which is what MUI's className did
    className?: string
}

// One wrapper, so every icon is the same size, takes its colour from the text, and is invisible to a screen
// reader unless it is the only thing carrying the meaning.
export function Icon({ size = 20, title, className, children }: IconProps & { children: ReactNode }) {
    return (
        <svg
            // Sized in em with the number carried by font-size, which is how MUI's SvgIcon sized itself.
            // Several stylesheets size an icon that way rather than by width: the wallpaper's clock, its now
            // playing card and its site links all say `font-size: ... !important`. A width in pixels here
            // would ignore every one of them, and the wallpaper would come out with five icons the wrong
            // size and nothing failing to say so.
            width="1em"
            height="1em"
            style={{ fontSize: `${size}px` }}
            viewBox="0 0 24 24"
            fill="currentColor"
            className={className}
            role={title ? 'img' : undefined}
            aria-hidden={title ? undefined : 'true'}
            aria-label={title}
            focusable="false"
        >
            {children}
        </svg>
    )
}
