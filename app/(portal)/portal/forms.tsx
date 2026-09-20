'use client'

// The shared shell and the forms that drive the pre-auth actions. useAction and Problem are copied verbatim
// from app/(admin)/admin/quotes/[id]/controls.tsx, with ActionResult renamed to PortalResult to match this
// area's own type.

import { useState } from 'react'
import type { ZodType } from 'zod'
import Link from 'next/link'
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material'

import { codeSchema, emailSchema, passwordSchema } from '@/server/clients/schema'
import {
    acknowledgeCodesAction, codeAction, completeInviteAction, completeResetAction,
    confirmEnrolmentAction, requestResetAction, signInAction, type PortalResult,
} from './actions'

function useAction() {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    async function run(action: () => Promise<PortalResult>, onDone?: () => void) {
        setPending(true)
        setError(null)
        try {
            const result = await action()
            if (result.ok) onDone?.()
            else setError(result.error)
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }
    return { pending, error, run }
}

const Problem = ({ error }: { error: string | null }) => (error ? <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert> : null)

// Instant feedback only: the schema the server applies is the one that counts, this just avoids a round trip
// for an address that is obviously not one, or a code that is obviously empty
function fieldProblem(value: string, schema: ZodType<string>): string | undefined {
    if (!value) return undefined
    const parsed = schema.safeParse(value)
    return parsed.success ? undefined : parsed.error.issues[0]?.message
}

export function Panel({ title, children }: { title: string, children: React.ReactNode }) {
    return (
        <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
            <Paper sx={{ p: 4, width: '100%', maxWidth: 380 }}>
                <Typography variant="h5" component="h1" sx={{ mb: 3, fontWeight: 700 }}>{title}</Typography>
                {children}
            </Paper>
        </Box>
    )
}

export function SignInForm() {
    const { pending, error, run } = useAction()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const emailProblem = fieldProblem(email, emailSchema)
    const passwordProblem = fieldProblem(password, passwordSchema)
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => signInAction(email, password)) }}>
            <TextField label="Email" type="email" fullWidth autoComplete="username" value={email}
                error={!!emailProblem} helperText={emailProblem}
                onChange={event => setEmail(event.target.value)} sx={{ mb: 2 }} />
            <TextField label="Password" type="password" fullWidth autoComplete="current-password" value={password}
                error={!!passwordProblem} helperText={passwordProblem}
                onChange={event => setPassword(event.target.value)} sx={{ mb: 2 }} />
            <Button type="submit" variant="contained" fullWidth size="large"
                disabled={pending || !email || !password || !!emailProblem || !!passwordProblem}>Sign in</Button>
            <Problem error={error} />
            <Box sx={{ mt: 2, textAlign: 'center' }}>
                <Link href="/portal/forgot" style={{ color: 'inherit', fontSize: '0.875rem' }}>Forgotten your password?</Link>
            </Box>
        </form>
    )
}

export function CodeForm() {
    const { pending, error, run } = useAction()
    const [code, setCode] = useState('')
    const codeProblem = fieldProblem(code, codeSchema)
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => codeAction(code)) }}>
            <TextField label="Code from your authenticator app" fullWidth autoComplete="one-time-code" inputMode="numeric"
                value={code} error={!!codeProblem} helperText={codeProblem ?? 'A recovery code works here too.'}
                onChange={event => setCode(event.target.value)} sx={{ mb: 2 }} />
            <Button type="submit" variant="contained" fullWidth size="large" disabled={pending || !code || !!codeProblem}>Verify</Button>
            <Problem error={error} />
        </form>
    )
}

function RecoveryCodes({ codes }: { codes: string[] }) {
    const { pending, error, run } = useAction()
    const [copied, setCopied] = useState(false)
    const text = codes.join('\n')

    async function copyCodes() {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
        } catch {
            // Clipboard access can be refused by the browser; the codes are still on screen and downloadable
            setCopied(false)
        }
    }

    function downloadCodes() {
        const blob = new Blob([text], { type: 'text/plain' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = 'horizons-recovery-codes.txt'
        link.click()
        URL.revokeObjectURL(url)
    }

    return (
        <div>
            <Typography variant="body2" sx={{ mb: 2 }}>
                Save these recovery codes somewhere safe, like a password manager. Each one signs you in once, if
                you ever lose access to your authenticator app. They will not be shown again.
            </Typography>
            <Box component="ul" sx={{
                fontFamily: 'monospace', listStyle: 'none', p: 2, m: 0, mb: 2,
                bgcolor: 'background.default', borderRadius: 1,
            }}>
                {codes.map(code => <li key={code}>{code}</li>)}
            </Box>
            <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                <Button variant="outlined" fullWidth onClick={copyCodes}>{copied ? 'Copied' : 'Copy'}</Button>
                <Button variant="outlined" fullWidth onClick={downloadCodes}>Download</Button>
            </Stack>
            <Button variant="contained" fullWidth size="large" disabled={pending}
                onClick={() => run(() => acknowledgeCodesAction())}>I have saved these</Button>
            <Problem error={error} />
        </div>
    )
}

export function EnrolmentForm({ qr, typed }: { qr: string, typed: string }) {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [code, setCode] = useState('')
    // Set once, from confirmEnrolmentAction's own result: the codes exist in plaintext only in that one
    // response, so there is nothing here to refetch and nowhere else they are stored
    const [codes, setCodes] = useState<string[] | null>(null)
    const codeProblem = fieldProblem(code, codeSchema)

    async function confirm(event: React.FormEvent) {
        event.preventDefault()
        setPending(true)
        setError(null)
        try {
            const result = await confirmEnrolmentAction(code)
            if (result.ok) setCodes(result.recoveryCodes)
            else setError(result.error)
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }

    if (codes) return <RecoveryCodes codes={codes} />

    return (
        <form onSubmit={confirm}>
            <Typography variant="body2" sx={{ mb: 2 }}>
                Scan this with your authenticator app, or type the code in below it.
            </Typography>
            <Box sx={{ display: 'grid', placeItems: 'center', mb: 2 }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URI, not something next/image can optimise */}
                <img src={qr} alt="QR code for your authenticator app" width={240} height={240} />
            </Box>
            <Typography variant="body2" sx={{ mb: 2, textAlign: 'center', fontFamily: 'monospace', letterSpacing: 1 }}>
                {typed}
            </Typography>
            <TextField label="Code from your authenticator app" fullWidth autoComplete="one-time-code" inputMode="numeric"
                value={code} error={!!codeProblem} helperText={codeProblem}
                onChange={event => setCode(event.target.value)} sx={{ mb: 2 }} />
            <Button type="submit" variant="contained" fullWidth size="large" disabled={pending || !code || !!codeProblem}>
                Confirm and continue
            </Button>
            <Problem error={error} />
        </form>
    )
}

export function InviteForm({ token }: { token: string }) {
    const { pending, error, run } = useAction()
    const [password, setPassword] = useState('')
    const passwordProblem = fieldProblem(password, passwordSchema)
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => completeInviteAction(token, password)) }}>
            <TextField label="Choose a password" type="password" fullWidth autoComplete="new-password" value={password}
                error={!!passwordProblem} helperText={passwordProblem}
                onChange={event => setPassword(event.target.value)} sx={{ mb: 2 }} />
            <Button type="submit" variant="contained" fullWidth size="large"
                disabled={pending || !password || !!passwordProblem}>Set password</Button>
            <Problem error={error} />
        </form>
    )
}

export function ForgotForm() {
    const [pending, setPending] = useState(false)
    const [message, setMessage] = useState<string | null>(null)
    const [email, setEmail] = useState('')
    const emailProblem = fieldProblem(email, emailSchema)

    async function submit(event: React.FormEvent) {
        event.preventDefault()
        setPending(true)
        try {
            // The one message covers every case, matching or not, valid or not: rendering anything else here
            // would turn this page into a way to find out which addresses have accounts.
            const result = await requestResetAction(email)
            setMessage(result.message)
        } finally {
            setPending(false)
        }
    }

    if (message) return <Typography variant="body2">{message}</Typography>

    return (
        <form onSubmit={submit}>
            <Typography variant="body2" sx={{ mb: 2 }}>
                Enter your email address and, if it has an account, we will send a link to reset your password.
            </Typography>
            <TextField label="Email" type="email" fullWidth autoComplete="username" value={email}
                error={!!emailProblem} helperText={emailProblem}
                onChange={event => setEmail(event.target.value)} sx={{ mb: 2 }} />
            <Button type="submit" variant="contained" fullWidth size="large"
                disabled={pending || !email || !!emailProblem}>Send reset link</Button>
        </form>
    )
}

export function ResetForm({ token, needsCode }: { token: string, needsCode: boolean }) {
    const { pending, error, run } = useAction()
    const [password, setPassword] = useState('')
    const [code, setCode] = useState('')
    const passwordProblem = fieldProblem(password, passwordSchema)
    const codeProblem = needsCode ? fieldProblem(code, codeSchema) : undefined
    // A client who never enrolled has no code to give, so the field is left out rather than disabled: the
    // request still carries an empty string, which completeResetAction accepts for that case.
    const canSubmit = !!password && !passwordProblem && (!needsCode || (!!code && !codeProblem))
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => completeResetAction(token, password, needsCode ? code : '')) }}>
            <TextField label="Choose a new password" type="password" fullWidth autoComplete="new-password" value={password}
                error={!!passwordProblem} helperText={passwordProblem}
                onChange={event => setPassword(event.target.value)} sx={{ mb: 2 }} />
            {needsCode && (
                <TextField label="Code from your authenticator app" fullWidth autoComplete="one-time-code" inputMode="numeric"
                    value={code} error={!!codeProblem} helperText={codeProblem ?? 'A recovery code works here too.'}
                    onChange={event => setCode(event.target.value)} sx={{ mb: 2 }} />
            )}
            <Button type="submit" variant="contained" fullWidth size="large" disabled={pending || !canSubmit}>
                Reset password
            </Button>
            <Problem error={error} />
        </form>
    )
}
