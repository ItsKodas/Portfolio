'use server'

// Everything the portal changes. The pre-auth actions validate their own token or half-session first; the rest
// call requireClient() first, exactly as the admin actions call requireAdmin().

import { redirect } from 'next/navigation'

import { CODE_PATH, PORTAL_HOME, SETUP_PATH, SIGN_IN_PATH, clearSessionCookie, readSession, requireClient, requirePendingSession, setSessionCookie } from '@/server/clients/auth'
import { EnvError } from '@/server/env'
import { codeSchema, emailSchema, passwordSchema } from '@/server/clients/schema'
import { codeStep, passwordStep } from '@/server/clients/signIn'
import { acknowledgeRecoveryCodes, confirmEnrolment } from '@/server/clients/setup'
import { acknowledgeDeps, codeStepDeps, confirmEnrolmentDeps, log, passwordStepDeps, repo, requestIpHash, requestUserAgent } from '@/server/clients/wiring'

export type PortalResult = { ok: true } | { ok: false, error: string }
export type CodesResult = { ok: true, recoveryCodes: string[] } | { ok: false, error: string }

// Not typed as PortalResult: that union would stop `.error` being read back off these below without a
// redundant `ok` check, since TS can't narrow a plain union-typed variable by its literal value.
const INVALID = { ok: false, error: 'That request was not valid.' } as const
const BROKEN = { ok: false, error: 'Something went wrong. Please try again.' } as const

// EnvError names the missing variable and never its value, so it is safe to show
const failure = (where: string, error: unknown): PortalResult => {
    if (error instanceof EnvError) return { ok: false, error: `${error.message}. Please let Koda know.` }
    log(`${where} failed`, error)
    return BROKEN
}

export async function signInAction(email: string, password: string): Promise<PortalResult> {
    const parsed = emailSchema.safeParse(email)
    if (!parsed.success || typeof password !== 'string' || !password) return INVALID
    try {
        const result = await passwordStep(
            { email: parsed.data, password, userAgent: await requestUserAgent() },
            passwordStepDeps(await requestIpHash()),
        )
        if (!result.ok) return result
        await setSessionCookie(result.token, result.expiresAt)
        redirect(result.next === 'code' ? CODE_PATH : SETUP_PATH)
    } catch (error) {
        // redirect() works by throwing, so it must not be swallowed here
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Client sign-in', error)
    }
}

export async function codeAction(code: string): Promise<PortalResult> {
    const parsed = codeSchema.safeParse(code)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    const session = await requirePendingSession()
    try {
        const result = await codeStep({ session, code: parsed.data }, codeStepDeps(await requestIpHash()))
        if (!result.ok) return result
        redirect(PORTAL_HOME)
    } catch (error) {
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Client second factor', error)
    }
}

export async function confirmEnrolmentAction(code: string): Promise<CodesResult> {
    const parsed = codeSchema.safeParse(code)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    const session = await requirePendingSession()
    try {
        return await confirmEnrolment({ session, code: parsed.data }, confirmEnrolmentDeps())
    } catch (error) {
        const result = failure('Authenticator enrolment', error)
        return result.ok ? { ok: false, error: BROKEN.error } : result
    }
}

export async function acknowledgeCodesAction(): Promise<PortalResult> {
    const session = await requirePendingSession()
    // Only reachable once the authenticator is confirmed, which is what makes this a safe place to finish
    if (!session.client.totpConfirmedAt) return INVALID
    try {
        await acknowledgeRecoveryCodes(session, acknowledgeDeps())
        redirect(PORTAL_HOME)
    } catch (error) {
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Finishing enrolment', error)
    }
}

export async function signOutAction(): Promise<void> {
    const session = await readSession()
    if (session) await repo().deleteSession(session.id)
    await clearSessionCookie()
    redirect(SIGN_IN_PATH)
}
