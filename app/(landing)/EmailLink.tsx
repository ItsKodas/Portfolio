'use client'

// "Email me": the address is never in the page, where scrapers would find it. Clicking opens a small window that runs
// Cloudflare's Turnstile check (usually without asking anything of a person), and only a passed check gets the address
// back from the server (see server/contact/reveal.ts), shown with a mail link and a copy button, which also helps
// anyone without a mail app set up.

import { useCallback, useState } from 'react'

import { Dialog } from '@/ui/Dialog/Dialog'
import Turnstile from '@/app/(quote)/quote/turnstile'

import { emailCheckAction, revealEmailAction } from './contactActions'

type State =
    | { at: 'closed' }
    | { at: 'loading' }
    | { at: 'checking', siteKey: string }
    | { at: 'shown', email: string }
    | { at: 'failed', siteKey: string }
    | { at: 'unavailable' }

export default function EmailLink({ className = '' }: { className?: string }) {
    const [state, setState] = useState<State>({ at: 'closed' })
    const [resets, setResets] = useState(0)
    const [copied, setCopied] = useState(false)

    const open = async () => {
        setState({ at: 'loading' })
        const { siteKey } = await emailCheckAction()
        setState(siteKey ? { at: 'checking', siteKey } : { at: 'unavailable' })
    }

    // A null token is the widget giving up (an error, an expired check, or a blocked script): say so rather than wait
    const onToken = useCallback(async (token: string | null) => {
        if (!token) {
            setState(now => now.at === 'checking' ? { at: 'failed', siteKey: now.siteKey } : now)
            return
        }
        const result = await revealEmailAction(token)
        setState(now => result.ok
            ? { at: 'shown', email: result.email }
            : { at: 'failed', siteKey: 'siteKey' in now ? now.siteKey : '' })
    }, [])

    const retry = () => {
        setState(now => now.at === 'failed' ? { at: 'checking', siteKey: now.siteKey } : now)
        setResets(n => n + 1)
    }

    const copy = async (email: string) => {
        try {
            await navigator.clipboard.writeText(email)
            setCopied(true)
        } catch {}
    }

    const close = () => { setState({ at: 'closed' }); setCopied(false) }

    return (
        <>
            <button type="button" onClick={open}
                className={`inline-flex items-center gap-2 rounded-full border border-[#b597cc]/35 bg-[#b597cc]/[0.07] px-5 py-2.5 text-sm font-semibold text-[#d9c6ea] transition-colors hover:border-[#b597cc]/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b597cc]/50 ${className}`}>
                Email me
            </button>

            <Dialog open={state.at !== 'closed'} onClose={close} title="Email me">
                <div className="text-left text-sm leading-relaxed">
                    {state.at === 'loading' && <p>Just a moment...</p>}

                    {(state.at === 'checking' || state.at === 'failed') && (
                        <>
                            <p className="mb-4">A quick check that you&apos;re a person, to keep my address away from spam bots.</p>
                            <Turnstile siteKey={state.siteKey} onToken={onToken} resetCount={resets} />
                            {state.at === 'failed' && (
                                <div className="mt-3 flex items-center gap-3">
                                    <p>The check didn&apos;t go through.</p>
                                    <button type="button" onClick={retry} className="font-semibold underline">Try again</button>
                                </div>
                            )}
                        </>
                    )}

                    {state.at === 'shown' && (
                        <>
                            <p className="mb-1">You can reach me at</p>
                            <p className="mb-4 select-all text-lg font-semibold">{state.email}</p>
                            <div className="flex flex-wrap gap-3">
                                <a href={`mailto:${state.email}`} className="rounded-full bg-[#8fd4f5] px-4 py-2 font-semibold text-[#0b101f] hover:bg-white">
                                    Open in your mail app
                                </a>
                                <button type="button" onClick={() => copy(state.email)} className="rounded-full border border-current px-4 py-2 font-semibold">
                                    {copied ? 'Copied' : 'Copy address'}
                                </button>
                            </div>
                        </>
                    )}

                    {state.at === 'unavailable' && (
                        <p>The check isn&apos;t available right now. You can reach me through LinkedIn or GitHub, linked on this page, or with the quote form.</p>
                    )}
                </div>
            </Dialog>
        </>
    )
}
