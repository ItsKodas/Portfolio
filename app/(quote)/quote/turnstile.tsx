'use client'

// Cloudflare's Turnstile check, rendered explicitly so it can be reset after each attempt (a token is only good once)

import Script from 'next/script'
import { useCallback, useEffect, useRef } from 'react'

type TurnstileOptions = {
    sitekey: string
    theme: 'dark'
    callback(token: string): void
    'expired-callback'(): void
    'error-callback'(): void
}

declare global {
    interface Window {
        turnstile?: {
            render(element: HTMLElement, options: TurnstileOptions): string
            reset(widgetId: string): void
            remove(widgetId: string): void
        }
    }
}

export default function Turnstile({ siteKey, onToken, resetCount }: { siteKey: string, onToken(token: string | null): void, resetCount: number }) {
    const box = useRef<HTMLDivElement>(null)
    const widget = useRef<string | null>(null)
    const handler = useRef(onToken)
    useEffect(() => { handler.current = onToken })

    const render = useCallback(() => {
        if (!window.turnstile || !box.current || widget.current) return
        widget.current = window.turnstile.render(box.current, {
            sitekey: siteKey,
            theme: 'dark',
            callback: token => handler.current(token),
            'expired-callback': () => handler.current(null),
            'error-callback': () => handler.current(null),
        })
    }, [siteKey])

    // The script may already be loaded (after navigating away and back), in which case its onLoad won't fire again
    useEffect(() => {
        render()
        return () => {
            if (widget.current) window.turnstile?.remove(widget.current)
            widget.current = null
        }
    }, [render])

    useEffect(() => {
        if (resetCount && widget.current) window.turnstile?.reset(widget.current)
    }, [resetCount])

    return (
        <>
            <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive" onLoad={render} />
            <div ref={box} className="min-h-[65px]" />
        </>
    )
}
