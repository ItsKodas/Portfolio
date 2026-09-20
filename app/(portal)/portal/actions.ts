'use server'

// Everything the portal changes. The pre-auth actions validate their own token or half-session first; the rest
// call requireClient() first, exactly as the admin actions call requireAdmin().

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

import { CODE_PATH, PORTAL_HOME, SETUP_PATH, SIGN_IN_PATH, clearSessionCookie, readSession, requireClient, requirePendingSession, setSessionCookie } from '@/server/clients/auth'
import { EnvError } from '@/server/env'
import { codeSchema, emailSchema, passwordSchema } from '@/server/clients/schema'
import { codeStep, passwordStep } from '@/server/clients/signIn'
import { acknowledgeRecoveryCodes, completeInvite, confirmEnrolment } from '@/server/clients/setup'
import { hashSessionToken } from '@/server/clients/session'
import { RESET_SENT_MESSAGE, completeReset, requestReset } from '@/server/clients/reset'
import {
    acknowledgeDeps, changePasswordDeps, codeStepDeps, completeInviteDeps, completeResetDeps, confirmEnrolmentDeps,
    log, passwordStepDeps, regenerateDeps, repo, requestIpHash, requestResetDeps, requestUserAgent,
    runChangePassword, runRegenerate,
} from '@/server/clients/wiring'

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
    // The code page redirects an unconfirmed enrolment to setup, but an action is reachable without its page.
    // Without this, a secret stored by beginEnrolment and scanned but never confirmed would finish a sign-in
    // on an account that has no recovery codes, exactly as acknowledgeCodesAction guards against below.
    if (!session.client.totpConfirmedAt) return INVALID
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

export async function completeInviteAction(token: string, password: string): Promise<PortalResult> {
    const parsed = passwordSchema.safeParse(password)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    if (typeof token !== 'string' || !token) return INVALID
    try {
        const result = await completeInvite(
            { tokenHash: hashSessionToken(token), password: parsed.data, userAgent: await requestUserAgent() },
            completeInviteDeps(),
        )
        if (!result.ok) return result
        await setSessionCookie(result.token, result.expiresAt)
        // Straight into enrolment: the account does nothing until an authenticator is set up
        redirect(SETUP_PATH)
    } catch (error) {
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Completing an invite', error)
    }
}

export async function requestResetAction(email: string): Promise<{ message: string }> {
    const parsed = emailSchema.safeParse(email)
    // The same answer for an invalid address as for a valid one that matches nothing
    if (!parsed.success) return { message: RESET_SENT_MESSAGE }
    try {
        return await requestReset({ email: parsed.data }, requestResetDeps(await requestIpHash()))
    } catch (error) {
        log('Requesting a password reset failed', error)
        return { message: RESET_SENT_MESSAGE }
    }
}

export async function completeResetAction(token: string, password: string, code: string): Promise<PortalResult> {
    const parsed = passwordSchema.safeParse(password)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    if (typeof token !== 'string' || !token || typeof code !== 'string') return INVALID
    try {
        const result = await completeReset(
            { tokenHash: hashSessionToken(token), password: parsed.data, code },
            completeResetDeps(await requestIpHash()),
        )
        if (!result.ok) return result
        redirect(`${SIGN_IN_PATH}?reset=1`)
    } catch (error) {
        if (error && typeof error === 'object' && 'digest' in error) throw error
        return failure('Completing a password reset', error)
    }
}

// requireClient() runs first in every action below, exactly as requireAdmin() does for the admin actions: it is
// what stands between a signed-out visitor, or one client, and another client's data.

export async function changePasswordAction(current: string, next: string): Promise<PortalResult> {
    const { client, sessionId } = await requireClient()
    const parsed = passwordSchema.safeParse(next)
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? INVALID.error }
    if (typeof current !== 'string' || !current) return INVALID
    try {
        // sessionId travels through so the pipeline can spare the session doing the changing while it drops the rest
        const result = await runChangePassword({ client, sessionId, current, next: parsed.data }, changePasswordDeps())
        if (result.ok) revalidatePath('/portal/account')
        return result
    } catch (error) {
        return failure('Changing a client password', error)
    }
}

export async function regenerateCodesAction(password: string): Promise<CodesResult> {
    const { client } = await requireClient()
    if (typeof password !== 'string' || !password) return { ok: false, error: INVALID.error }
    try {
        const result = await runRegenerate({ client, password }, regenerateDeps())
        if (result.ok) revalidatePath('/portal/account')
        return result
    } catch (error) {
        const failed = failure('Regenerating recovery codes', error)
        return failed.ok ? { ok: false, error: BROKEN.error } : failed
    }
}

export async function signOutElsewhereAction(): Promise<PortalResult> {
    const { client, sessionId } = await requireClient()
    try {
        await repo().deleteSessionsFor(client.id, sessionId)
        revalidatePath('/portal/account')
        return { ok: true }
    } catch (error) {
        return failure('Signing out other sessions', error)
    }
}
