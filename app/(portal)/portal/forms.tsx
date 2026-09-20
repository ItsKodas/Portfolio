'use client'

// The shared shell and the forms that drive the pre-auth actions. useAction and Problem are copied verbatim
// from app/(admin)/admin/quotes/[id]/controls.tsx, with ActionResult renamed to PortalResult to match this
// area's own type.

import { useState } from 'react'
import type { ZodType } from 'zod'
import Link from 'next/link'
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material'

import { MIN_PASSWORD_LENGTH, codeSchema, emailSchema, passwordSchema } from '@/server/clients/schema'
import {
    acknowledgeCodesAction, changePasswordAction, codeAction, completeInviteAction, completeResetAction,
    confirmEnrolmentAction, regenerateCodesAction, requestResetAction, signInAction, signOutElsewhereAction,
    type PortalResult,
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

// Length only, because the rule is length only. A meter implying we score the password would be
// telling the client something the server does not actually check.
function passwordHint(password: string): string {
    if (password.length === 0) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
    if (password.length < MIN_PASSWORD_LENGTH) return `${MIN_PASSWORD_LENGTH - password.length} more to go.`
    return 'That will do nicely. Longer is better.'
}

const CONFIRM_MISMATCH = 'Those two passwords are not the same.'

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

// The list-and-buttons half of showing a batch of recovery codes, shared by enrolment (RecoveryCodes below) and
// the account page's RegenerateCodesForm. Each caller supplies its own notice and its own way to move on.
function RecoveryCodesList({ codes, notice, children }: { codes: string[], notice: string, children: React.ReactNode }) {
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
            <Typography variant="body2" sx={{ mb: 2 }}>{notice}</Typography>
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
            {children}
        </div>
    )
}

function RecoveryCodes({ codes }: { codes: string[] }) {
    const { pending, error, run } = useAction()
    return (
        <RecoveryCodesList codes={codes} notice="Save these recovery codes somewhere safe, like a password manager. Each one signs you in once, if you ever lose access to your authenticator app. They will not be shown again.">
            <Button variant="contained" fullWidth size="large" disabled={pending}
                onClick={() => run(() => acknowledgeCodesAction())}>I have saved these</Button>
            <Problem error={error} />
        </RecoveryCodesList>
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
    const [confirm, setConfirm] = useState('')
    const passwordProblem = fieldProblem(password, passwordSchema)
    // Set once, from an emailed link, by someone who cannot try again without looping back through the
    // single-field "Forgotten your password?" form: a typo here is expensive, so it is caught before submit
    const mismatch = confirm.length > 0 && confirm !== password
    const canSubmit = !!password && !passwordProblem && !!confirm && !mismatch
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => completeInviteAction(token, password)) }}>
            <TextField label="Choose a password" type="password" fullWidth autoComplete="new-password" value={password}
                error={!!passwordProblem} helperText={passwordHint(password)}
                onChange={event => setPassword(event.target.value)} sx={{ mb: 2 }} />
            <TextField label="Confirm password" type="password" fullWidth autoComplete="new-password" value={confirm}
                error={mismatch} helperText={mismatch ? CONFIRM_MISMATCH : undefined}
                onChange={event => setConfirm(event.target.value)} sx={{ mb: 2 }} />
            <Button type="submit" variant="contained" fullWidth size="large"
                disabled={pending || !canSubmit}>Set password</Button>
            <Problem error={error} />
        </form>
    )
}

export function ForgotForm() {
    // Not useAction: requestResetAction resolves to { message }, not a PortalResult, so it has nothing for
    // useAction's `result.ok` branch to read. The catch below is the same fallback useAction gives every
    // other form, added by hand because the return shape does not fit the shared hook.
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [email, setEmail] = useState('')
    const emailProblem = fieldProblem(email, emailSchema)

    async function submit(event: React.FormEvent) {
        event.preventDefault()
        setPending(true)
        setError(null)
        try {
            // The one message covers every case, matching or not, valid or not: rendering anything else here
            // would turn this page into a way to find out which addresses have accounts.
            const result = await requestResetAction(email)
            setMessage(result.message)
        } catch {
            setError('That did not work. Try reloading the page.')
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
            <Problem error={error} />
        </form>
    )
}

export function ResetForm({ token, needsCode }: { token: string, needsCode: boolean }) {
    const { pending, error, run } = useAction()
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [code, setCode] = useState('')
    const passwordProblem = fieldProblem(password, passwordSchema)
    const codeProblem = needsCode ? fieldProblem(code, codeSchema) : undefined
    // Same reasoning as the invite form: this is the one other place a client sets a password by typing it
    // once into a page they can only reach from a link, so a typo is caught before submit rather than after.
    const mismatch = confirm.length > 0 && confirm !== password
    // A client who never enrolled has no code to give, so the field is left out rather than disabled: the
    // request still carries an empty string, which completeResetAction accepts for that case.
    const canSubmit = !!password && !passwordProblem && !!confirm && !mismatch && (!needsCode || (!!code && !codeProblem))
    return (
        <form onSubmit={event => { event.preventDefault(); run(() => completeResetAction(token, password, needsCode ? code : '')) }}>
            <TextField label="Choose a new password" type="password" fullWidth autoComplete="new-password" value={password}
                error={!!passwordProblem} helperText={passwordHint(password)}
                onChange={event => setPassword(event.target.value)} sx={{ mb: 2 }} />
            <TextField label="Confirm password" type="password" fullWidth autoComplete="new-password" value={confirm}
                error={mismatch} helperText={mismatch ? CONFIRM_MISMATCH : undefined}
                onChange={event => setConfirm(event.target.value)} sx={{ mb: 2 }} />
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

// The account page's own forms, below. Unlike everything above, these run against an already-signed-in
// session, so none of them redirect on success: they update in place and leave the client on the page.

export function ChangePasswordForm() {
    const { pending, error, run } = useAction()
    const [current, setCurrent] = useState('')
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [done, setDone] = useState(false)
    const passwordProblem = fieldProblem(password, passwordSchema)
    const mismatch = confirm.length > 0 && confirm !== password
    const canSubmit = !!current && !!password && !passwordProblem && !!confirm && !mismatch

    function submit(event: React.FormEvent) {
        event.preventDefault()
        setDone(false)
        run(() => changePasswordAction(current, password), () => {
            setDone(true)
            setCurrent('')
            setPassword('')
            setConfirm('')
        })
    }

    return (
        <form onSubmit={submit}>
            <TextField label="Current password" type="password" fullWidth autoComplete="current-password" value={current}
                onChange={event => setCurrent(event.target.value)} sx={{ mb: 2 }} />
            <TextField label="New password" type="password" fullWidth autoComplete="new-password" value={password}
                error={!!passwordProblem} helperText={passwordHint(password)}
                onChange={event => setPassword(event.target.value)} sx={{ mb: 2 }} />
            <TextField label="Confirm new password" type="password" fullWidth autoComplete="new-password" value={confirm}
                error={mismatch} helperText={mismatch ? CONFIRM_MISMATCH : undefined}
                onChange={event => setConfirm(event.target.value)} sx={{ mb: 2 }} />
            <Button type="submit" variant="contained" disabled={pending || !canSubmit}>Change password</Button>
            {done && (
                <Alert severity="success" sx={{ mt: 2 }}>
                    Your password has been changed. This device stays signed in, and every other session has been signed out.
                </Alert>
            )}
            <Problem error={error} />
        </form>
    )
}

export function RegenerateCodesForm() {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [password, setPassword] = useState('')
    // Set once, from regenerateCodesAction's own result, the same way enrolment holds its codes: this is the
    // only place the plaintext exists, and there is nothing here worth persisting client-side.
    const [codes, setCodes] = useState<string[] | null>(null)

    async function submit(event: React.FormEvent) {
        event.preventDefault()
        setPending(true)
        setError(null)
        try {
            const result = await regenerateCodesAction(password)
            if (result.ok) {
                setCodes(result.recoveryCodes)
                // Only on success, like every other form here: clearing after a refusal would throw away what
                // was typed, which is exactly what someone who has just mistyped their password does not want
                setPassword('')
            } else setError(result.error)
        } catch {
            setError('That did not work. Try reloading the page.')
        } finally {
            setPending(false)
        }
    }

    if (codes) {
        return (
            <RecoveryCodesList codes={codes} notice="Save these somewhere safe, like a password manager. Your previous recovery codes have stopped working. Each new one signs you in once, if you ever lose access to your authenticator app, and they will not be shown again.">
                <Button variant="contained" fullWidth size="large" onClick={() => setCodes(null)}>Done</Button>
            </RecoveryCodesList>
        )
    }

    return (
        <form onSubmit={submit}>
            <Typography variant="body2" sx={{ mb: 2 }}>
                Confirm your password to generate a new set of recovery codes. The old set stops working as soon as the new one is created.
            </Typography>
            <TextField label="Password" type="password" fullWidth autoComplete="current-password" value={password}
                onChange={event => setPassword(event.target.value)} sx={{ mb: 2 }} />
            <Button type="submit" variant="contained" disabled={pending || !password}>Generate new codes</Button>
            <Problem error={error} />
        </form>
    )
}

export function SignOutElsewhereButton() {
    const { pending, error, run } = useAction()
    return (
        <Box>
            <Button variant="outlined" color="error" disabled={pending}
                onClick={() => run(() => signOutElsewhereAction())}>Sign out everywhere else</Button>
            <Problem error={error} />
        </Box>
    )
}
