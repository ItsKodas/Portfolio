// The Environments tab's client pieces: one environment's Summary with its copy and delete actions, the
// deleted environments under the list, and the add form. Adding, deleting, restoring and copying are the
// operator's alone, so a client gets none of them drawn.

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const addEnvironmentAction = vi.fn()
const deleteEnvironmentAction = vi.fn()
const restoreEnvironmentAction = vi.fn()
const copyFromLiveAction = vi.fn()
const copyRunsAction = vi.fn()
const refresh = vi.fn()
const push = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh(), push: (...args: unknown[]) => push(...args) }) }))
vi.mock('./actions', () => ({
    addEnvironmentAction: (...args: unknown[]) => addEnvironmentAction(...args),
    deleteEnvironmentAction: (...args: unknown[]) => deleteEnvironmentAction(...args),
    restoreEnvironmentAction: (...args: unknown[]) => restoreEnvironmentAction(...args),
    copyFromLiveAction: (...args: unknown[]) => copyFromLiveAction(...args),
    copyRunsAction: (...args: unknown[]) => copyRunsAction(...args),
}))

const { AddEnvironment, DeletedEnvironments, EnvironmentSummary, EnvironmentsSaid } = await import('./environments')

const live = { name: 'live', branch: 'main', domain: 'acme.com', deployed: '5f0ac31aa1f4e0c1b2d3e4f5a6b7c8d9e0f1a2b3', port: 5010 }
const uat1 = { name: 'uat1', branch: 'uat', domain: 'uat.acme.com', deployed: null, port: 5011 }
const uat2 = { name: 'uat2', branch: 'develop', domain: null, deployed: null, port: 5012 }

const deletedRecord = {
    environment: 'uat2',
    deletedAt: '2026-09-20T10:00:00.000Z',
    purgeAt: '2026-10-20T10:00:00.000Z',
    branch: 'develop',
    domain: 'uat2.acme.com',
    aliases: [],
}
const NOW = new Date('2026-09-24T10:00:00.000Z')

type SummaryProps = Partial<Parameters<typeof EnvironmentSummary>[0]>
type DeletedProps = Partial<Parameters<typeof DeletedEnvironments>[0]>
type AddProps = Partial<Parameters<typeof AddEnvironment>[0]>

// Each piece inside the provider the tab wraps them in, which is where what an action said is shown
const summary = (over: SummaryProps = {}) => (
    <EnvironmentsSaid>
        <EnvironmentSummary id="acme" siteName="Acme Bakery" isAdmin environment={uat1} {...over} />
    </EnvironmentsSaid>
)
const deletedList = (over: DeletedProps = {}) => (
    <EnvironmentsSaid>
        <DeletedEnvironments id="acme" deleted={[deletedRecord]} deletedError={null} now={NOW} {...over} />
    </EnvironmentsSaid>
)
const adding = (over: AddProps = {}) => (
    <AddEnvironment id="acme" taken={['live', 'uat1']} branches={['main', 'uat', 'develop']} {...over} />
)

beforeEach(() => {
    vi.clearAllMocks()
    addEnvironmentAction.mockResolvedValue({ ok: true, message: 'uat3 is added. Its first deploy starts it.' })
    deleteEnvironmentAction.mockResolvedValue({ ok: true, message: 'uat1 is deleted.' })
    restoreEnvironmentAction.mockResolvedValue({ ok: true, message: 'uat2 is back and starting.' })
    copyFromLiveAction.mockResolvedValue({ ok: true, run: 'r1', message: "Copying live's data into uat1. It can take a few minutes." })
    copyRunsAction.mockResolvedValue({ ok: true, runs: [], running: false })
})

describe('the Summary', () => {
    it('shows the branch, the deployed commit and, for the operator, the port', () => {
        render(summary({ environment: live }))
        const section = within(screen.getByRole('region', { name: 'Summary' }))
        expect(section.getByText('main')).toBeInTheDocument()
        expect(section.getByText('5f0ac31')).toBeInTheDocument()
        expect(section.getByText('5010')).toBeInTheDocument()
    })

    it('says an environment that has never been deployed is not deployed', () => {
        render(summary())
        expect(screen.getByText('not deployed yet')).toBeInTheDocument()
    })

    it('shows a client the branch and commit, but no port and no actions', async () => {
        render(summary({ isAdmin: false }))
        await act(async () => {})
        const section = within(screen.getByRole('region', { name: 'Summary' }))
        expect(section.getByText('uat')).toBeInTheDocument()
        expect(section.queryByText('5011')).toBeNull()
        expect(section.queryByText(/port/i)).toBeNull()
        expect(screen.queryByRole('button')).toBeNull()
        // The copy runs are the operator's alone, so a client's page never asks for them
        expect(copyRunsAction).not.toHaveBeenCalled()
    })

    it('offers the operator Copy and Delete on an environment other than live', () => {
        render(summary())
        expect(screen.getByRole('button', { name: 'Copy data from live into uat1' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Delete uat1' })).toBeInTheDocument()
    })

    it('offers neither on live', async () => {
        render(summary({ environment: live }))
        await act(async () => {})
        expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
        expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
        expect(copyRunsAction).not.toHaveBeenCalled()
    })
})

describe('adding an environment', () => {
    it('says a reserved name is reserved, and will not send it', async () => {
        render(adding())
        await userEvent.type(screen.getByLabelText('Name'), 'next')
        expect(screen.getByText('next is reserved. Choose another name.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Add environment' })).toBeDisabled()
    })

    it('says what the rule is for a hyphen, and will not send it', async () => {
        render(adding())
        await userEvent.type(screen.getByLabelText('Name'), 'uat-3')
        expect(screen.getByText(/lowercase letters and digits/i)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Add environment' })).toBeDisabled()
    })

    it('says so when the site has that name already', async () => {
        render(adding())
        await userEvent.type(screen.getByLabelText('Name'), 'uat1')
        expect(screen.getByText('This site has uat1 already.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Add environment' })).toBeDisabled()
    })

    it('needs a branch before it can send', async () => {
        render(adding())
        await userEvent.type(screen.getByLabelText('Name'), 'uat3')
        expect(screen.getByRole('button', { name: 'Add environment' })).toBeDisabled()
    })

    it('sends the name, a branch from the repository and the hostname, then re-reads the page', async () => {
        render(adding())
        await userEvent.type(screen.getByLabelText('Name'), 'uat3')
        await userEvent.selectOptions(screen.getByLabelText('Branch'), 'develop')
        await userEvent.type(screen.getByLabelText(/hostname/i), 'uat3.acme.com')
        await userEvent.click(screen.getByRole('button', { name: 'Add environment' }))

        expect(addEnvironmentAction).toHaveBeenCalledWith('acme', 'uat3', 'develop', 'uat3.acme.com', false)
        expect(await screen.findByText('uat3 is added. Its first deploy starts it.')).toBeInTheDocument()
        expect(refresh).toHaveBeenCalled()
    })

    it('sends no hostname as null', async () => {
        render(adding())
        await userEvent.type(screen.getByLabelText('Name'), 'uat3')
        await userEvent.selectOptions(screen.getByLabelText('Branch'), 'develop')
        await userEvent.click(screen.getByRole('button', { name: 'Add environment' }))

        expect(addEnvironmentAction).toHaveBeenCalledWith('acme', 'uat3', 'develop', null, false)
    })

    it('shows hostd\'s refusal and keeps what was typed', async () => {
        addEnvironmentAction.mockResolvedValue({ ok: false, error: 'uat3 was deleted and is still kept for a restore; restore it or wait for it to be purged' })
        render(adding())
        await userEvent.type(screen.getByLabelText('Name'), 'uat3')
        await userEvent.selectOptions(screen.getByLabelText('Branch'), 'develop')
        await userEvent.click(screen.getByRole('button', { name: 'Add environment' }))

        expect(await screen.findByText(/restore it or wait/)).toBeInTheDocument()
        expect(screen.getByLabelText('Name')).toHaveValue('uat3')
        expect(refresh).not.toHaveBeenCalled()
    })

    it("asks for a copy of live's data when the box is ticked, and says what came of it", async () => {
        addEnvironmentAction.mockResolvedValue({ ok: true, message: "uat3 is added. A copy of live's data into it has started." })
        render(adding())
        await userEvent.type(screen.getByLabelText('Name'), 'uat3')
        await userEvent.selectOptions(screen.getByLabelText('Branch'), 'develop')
        const box = screen.getByRole('checkbox', { name: "Start with a copy of live's data" })
        expect(box).not.toBeChecked()
        await userEvent.click(box)
        await userEvent.click(screen.getByRole('button', { name: 'Add environment' }))

        expect(addEnvironmentAction).toHaveBeenCalledWith('acme', 'uat3', 'develop', null, true)
        expect(await screen.findByText(/A copy of live's data into it has started/)).toBeInTheDocument()
        // Unticked again for the next one, with the rest of the form
        expect(screen.getByRole('checkbox', { name: "Start with a copy of live's data" })).not.toBeChecked()
    })

    it('takes a branch by hand when the repository\'s branches could not be read', async () => {
        render(adding({ branches: null }))
        await userEvent.type(screen.getByLabelText('Name'), 'uat3')
        await userEvent.type(screen.getByLabelText('Branch'), 'feature')
        await userEvent.click(screen.getByRole('button', { name: 'Add environment' }))

        expect(addEnvironmentAction).toHaveBeenCalledWith('acme', 'uat3', 'feature', null, false)
    })
})

describe('deleting an environment', () => {
    it('says it is stopped and kept for 30 days, and only deletes once the site name is typed back', async () => {
        render(summary())
        await userEvent.click(screen.getByRole('button', { name: 'Delete uat1' }))

        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText(/stopped/i)).toBeInTheDocument()
        expect(within(dialog).getByText(/30 days/)).toBeInTheDocument()

        const confirm = within(dialog).getByRole('button', { name: 'Delete environment' })
        expect(confirm).toBeDisabled()
        await userEvent.type(within(dialog).getByLabelText('Type Acme Bakery to confirm'), 'acme bakery')
        expect(confirm).toBeDisabled()

        await userEvent.clear(within(dialog).getByLabelText(/to confirm/))
        await userEvent.type(within(dialog).getByLabelText(/to confirm/), 'Acme Bakery')
        await userEvent.click(confirm)

        expect(deleteEnvironmentAction).toHaveBeenCalledWith('acme', 'uat1', 'Acme Bakery')
        expect(await screen.findByText('uat1 is deleted.')).toBeInTheDocument()
    })

    // The environment is gone, so the tab goes back to live rather than staying on a name that now falls
    // back to it anyway
    it('goes back to live once it is deleted', async () => {
        render(summary())
        await userEvent.click(screen.getByRole('button', { name: 'Delete uat1' }))
        const dialog = screen.getByRole('dialog')
        await userEvent.type(within(dialog).getByLabelText(/to confirm/), 'Acme Bakery')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }))

        expect(push).toHaveBeenCalledWith('/portal/sites/acme?tab=environments', { scroll: false })
    })

    it('stays open and says why when hostd refuses', async () => {
        deleteEnvironmentAction.mockResolvedValue({ ok: false, error: 'could not stop uat1' })
        render(summary())
        await userEvent.click(screen.getByRole('button', { name: 'Delete uat1' }))

        const dialog = screen.getByRole('dialog')
        await userEvent.type(within(dialog).getByLabelText(/to confirm/), 'Acme Bakery')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }))

        expect(await within(dialog).findByText('could not stop uat1')).toBeInTheDocument()
        expect(push).not.toHaveBeenCalled()
        expect(refresh).not.toHaveBeenCalled()
    })
})

describe('deleted environments', () => {
    it('lists each with when it was deleted and the days left before it is purged', () => {
        render(deletedList())
        const list = within(screen.getByRole('list', { name: 'Deleted environments' }))
        expect(list.getByText('uat2')).toBeInTheDocument()
        expect(list.getByText(/20 September 2026/)).toBeInTheDocument()
        expect(list.getByText(/26 days left/)).toBeInTheDocument()
    })

    it('says a single day in the singular, and none left as due', () => {
        const { unmount } = render(deletedList({ deleted: [{ ...deletedRecord, purgeAt: '2026-09-25T09:00:00.000Z' }] }))
        expect(screen.getByText(/1 day left/)).toBeInTheDocument()
        unmount()

        render(deletedList({ deleted: [{ ...deletedRecord, purgeAt: '2026-09-24T09:00:00.000Z' }] }))
        expect(screen.getByText(/due to be purged/)).toBeInTheDocument()
    })

    // hostd refuses a restore past 30 days, and the next sweep purges it, so the button would only ever
    // produce a refusal
    it('offers no restore once the purge date has passed, and says why', async () => {
        render(deletedList({ deleted: [{ ...deletedRecord, purgeAt: '2026-09-24T09:00:00.000Z' }] }))
        const button = screen.getByRole('button', { name: 'Restore uat2' })
        expect(button).toBeDisabled()
        expect(screen.getByText(/past its 30 days, so it can no longer be restored/)).toBeInTheDocument()
        await userEvent.click(button)
        expect(restoreEnvironmentAction).not.toHaveBeenCalled()
    })

    it('still offers a restore before the purge date', () => {
        render(deletedList())
        expect(screen.getByRole('button', { name: 'Restore uat2' })).toBeEnabled()
        expect(screen.queryByText(/can no longer be restored/)).toBeNull()
    })

    it('restores the deletion it names, and shows what hostd reported', async () => {
        restoreEnvironmentAction.mockResolvedValue({
            ok: true,
            message: 'uat2 is back and starting. Its old port was taken, so it is on port 5019 now. '
                + 'These hostnames were taken while it was deleted, so it came back without them: uat2.acme.com.',
        })
        render(deletedList())
        await userEvent.click(screen.getByRole('button', { name: 'Restore uat2' }))

        expect(restoreEnvironmentAction).toHaveBeenCalledWith('acme', 'uat2', '2026-09-20T10:00:00.000Z')
        expect(await screen.findByText(/on port 5019 now/)).toBeInTheDocument()
        expect(screen.getByText(/came back without them: uat2\.acme\.com/)).toBeInTheDocument()
        expect(refresh).toHaveBeenCalled()
    })

    it('shows a refused restore in hostd\'s words', async () => {
        restoreEnvironmentAction.mockResolvedValue({ ok: false, error: 'acme has a uat2 environment now' })
        render(deletedList())
        await userEvent.click(screen.getByRole('button', { name: 'Restore uat2' }))

        expect(await screen.findByText('acme has a uat2 environment now')).toBeInTheDocument()
    })

    it('says nothing is deleted when nothing is', () => {
        render(deletedList({ deleted: [] }))
        expect(screen.queryByRole('list', { name: 'Deleted environments' })).toBeNull()
        expect(screen.getByText(/no deleted environments/i)).toBeInTheDocument()
    })

    it('says the list could not be read, rather than that there is none', () => {
        render(deletedList({ deleted: null, deletedError: 'hostd is not answering' }))
        expect(screen.getByText(/could not be read: hostd is not answering/)).toBeInTheDocument()
        expect(screen.queryByText(/no deleted environments/i)).toBeNull()
    })
})

const record = (over: Record<string, unknown> = {}) => ({
    project: 'acme',
    environment: 'uat1',
    run: 'r1',
    actor: 'koda@horizons.gg',
    startedAt: '2026-09-25T10:00:00.000Z',
    durationMs: null,
    outcome: 'running',
    step: null,
    reason: null,
    services: ['db'],
    storage: ['uploads'],
    ...over,
})

describe('copying live data into an environment', () => {
    it('says what is replaced, that it is client data and where it may be reachable, and needs the name typed back', async () => {
        render(summary())
        await userEvent.click(screen.getByRole('button', { name: 'Copy data from live into uat1' }))

        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText(/databases and storage are replaced with live's current data/)).toBeInTheDocument()
        expect(within(dialog).getByText(/real client data/)).toBeInTheDocument()
        expect(within(dialog).getByText(/reachable at uat\.acme\.com/)).toBeInTheDocument()

        const confirm = within(dialog).getByRole('button', { name: 'Copy data' })
        expect(confirm).toBeDisabled()
        await userEvent.type(within(dialog).getByLabelText('Type uat1 to confirm'), 'uat')
        expect(confirm).toBeDisabled()
        await userEvent.type(within(dialog).getByLabelText('Type uat1 to confirm'), '1')
        await userEvent.click(confirm)

        expect(copyFromLiveAction).toHaveBeenCalledWith('acme', 'uat1', 'uat1')
        expect(await screen.findByText("Copying live's data into uat1. It can take a few minutes.")).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('says it may be reachable at a hostname later when the environment has none yet', async () => {
        render(summary({ environment: { ...uat1, domain: null } }))
        await userEvent.click(screen.getByRole('button', { name: 'Copy data from live into uat1' }))
        expect(within(screen.getByRole('dialog')).getByText(/reachable at any hostname uat1 is given/)).toBeInTheDocument()
    })

    it('stays open and says why when hostd refuses', async () => {
        copyFromLiveAction.mockResolvedValue({ ok: false, error: 'uat1 is busy deploying' })
        render(summary())
        await userEvent.click(screen.getByRole('button', { name: 'Copy data from live into uat1' }))
        const dialog = screen.getByRole('dialog')
        await userEvent.type(within(dialog).getByLabelText('Type uat1 to confirm'), 'uat1')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Copy data' }))

        expect(await within(dialog).findByText('uat1 is busy deploying')).toBeInTheDocument()
    })

    it('reads the runs of the environment shown', async () => {
        render(summary())
        await act(async () => {})
        expect(copyRunsAction).toHaveBeenCalledWith('acme', 'uat1')
    })

    describe('while a copy runs', () => {
        beforeEach(() => { vi.useFakeTimers() })
        afterEach(() => { vi.useRealTimers() })

        // The action is a promise, which settles in a microtask rather than on the clock
        const settle = () => act(async () => {})
        const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })

        it('polls every 3 seconds, then says it is done and stops', async () => {
            copyRunsAction
                .mockResolvedValueOnce({ ok: true, runs: [record()], running: true })
                .mockResolvedValueOnce({ ok: true, runs: [record()], running: true })
                .mockResolvedValue({ ok: true, runs: [record({ outcome: 'ok', durationMs: 90_000 })], running: false })
            render(summary())
            await settle()

            expect(screen.getByText('Copying from live...')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Copy data from live into uat1' })).toBeDisabled()
            expect(copyRunsAction).toHaveBeenCalledTimes(1)

            await wait(2999)
            expect(copyRunsAction).toHaveBeenCalledTimes(1)
            await wait(1)
            expect(copyRunsAction).toHaveBeenCalledTimes(2)
            expect(screen.getByText('Copying from live...')).toBeInTheDocument()

            await wait(3000)
            expect(copyRunsAction).toHaveBeenCalledTimes(3)
            expect(screen.getByText(/Copied from live/)).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Copy data from live into uat1' })).toBeEnabled()

            await wait(9000)
            expect(copyRunsAction).toHaveBeenCalledTimes(3)
        })

        it('says which step failed and why', async () => {
            copyRunsAction
                .mockResolvedValueOnce({ ok: true, runs: [record()], running: true })
                .mockResolvedValue({
                    ok: true,
                    runs: [record({ outcome: 'failed', step: 'load:db', reason: 'psql exited 3' })],
                    running: false,
                })
            render(summary())
            await settle()
            expect(screen.getByText('Copying from live...')).toBeInTheDocument()

            await wait(3000)
            expect(screen.getByText(/The copy from live failed at load:db: psql exited 3/)).toBeInTheDocument()
            await wait(9000)
            expect(copyRunsAction).toHaveBeenCalledTimes(2)
        })

        // hostd's first step checks the disk, before anything is dumped or changed
        it('does not call a copy that failed its space check partly copied', async () => {
            const reason = 'only 3.0 GiB is free under /var/www/acme; a copy needs 10 GiB plus the size of live\'s storage (1.0 GiB)'
            copyRunsAction.mockResolvedValue({ ok: true, runs: [record({ outcome: 'failed', step: 'space', reason })], running: false })
            render(summary())
            await settle()
            const state = screen.getByText(/The copy from live failed at space: only 3\.0 GiB is free/)
            expect(state.textContent).not.toMatch(/partly copied/)
        })

        // hostd adds its own note for the steps that write into the environment, so it is said once
        it('says partly copied once when hostd already says it', async () => {
            const reason = 'db: the load exited with code 3: boom The environment may be partly copied; a new copy will overwrite it.'
            copyRunsAction.mockResolvedValue({ ok: true, runs: [record({ outcome: 'failed', step: 'load:db', reason })], running: false })
            render(summary())
            await settle()
            const state = screen.getByText(/The copy from live failed at load:db/)
            expect(state.textContent?.match(/partly copied/g)).toHaveLength(1)
        })

        // A run the agent restarted during has no step, and may have got as far as the load
        it('says a copy the agent restarted during may be partly copied', async () => {
            copyRunsAction.mockResolvedValue({
                ok: true, runs: [record({ outcome: 'failed', step: null, reason: 'the agent restarted during the copy' })], running: false,
            })
            render(summary())
            await settle()
            expect(screen.getByText(/The copy from live failed: the agent restarted during the copy\. It may be partly copied/)).toBeInTheDocument()
        })

        it('starts polling once a copy is started from the dialog', async () => {
            copyRunsAction
                .mockResolvedValueOnce({ ok: true, runs: [], running: false })
                .mockResolvedValue({ ok: true, runs: [record()], running: true })
            render(summary())
            await settle()
            expect(copyRunsAction).toHaveBeenCalledTimes(1)

            fireEvent.click(screen.getByRole('button', { name: 'Copy data from live into uat1' }))
            fireEvent.change(screen.getByLabelText('Type uat1 to confirm'), { target: { value: 'uat1' } })
            fireEvent.click(screen.getByRole('button', { name: 'Copy data' }))
            await settle()
            await settle()

            expect(copyRunsAction).toHaveBeenCalledTimes(2)
            expect(screen.getByText('Copying from live...')).toBeInTheDocument()
            await wait(3000)
            expect(copyRunsAction).toHaveBeenCalledTimes(3)
        })

        // Choosing another environment in the list navigates to this same route, which rerenders the
        // Summary rather than remounting it. Without a key of its own, one environment's running copy
        // and open confirm would carry over to the next one shown.
        it("does not carry one environment's running copy or open confirm onto the next one shown", async () => {
            copyRunsAction.mockImplementation(async (_id: string, environment: string) => (environment === 'uat1'
                ? { ok: true, runs: [record()], running: true }
                : { ok: true, runs: [], running: false }))
            const { rerender } = render(summary())
            await settle()
            expect(screen.getByText('Copying from live...')).toBeInTheDocument()

            // uat1's delete confirm is open as it goes, which must not become a confirm for uat2
            fireEvent.click(screen.getByRole('button', { name: 'Delete uat1' }))
            expect(screen.getByRole('dialog')).toBeInTheDocument()

            rerender(summary({ environment: uat2 }))
            // Before the next read lands, which is when a reused Summary would still show uat1's state
            expect(screen.queryByText('Copying from live...')).toBeNull()
            expect(screen.queryByRole('dialog')).toBeNull()
            await settle()

            expect(screen.queryByText('Copying from live...')).toBeNull()
            expect(screen.getByRole('button', { name: 'Copy data from live into uat2' })).toBeEnabled()
        })

        it('hands the button back when a read fails mid copy, and says why', async () => {
            copyRunsAction
                .mockResolvedValueOnce({ ok: true, runs: [record()], running: true })
                .mockResolvedValue({ ok: false, error: 'hostd is not answering' })
            render(summary())
            await settle()
            expect(screen.getByRole('button', { name: 'Copy data from live into uat1' })).toBeDisabled()

            await wait(3000)
            expect(screen.getByText(/The copies could not be read: hostd is not answering/)).toBeInTheDocument()
            expect(screen.queryByText('Copying from live...')).toBeNull()
            expect(screen.getByRole('button', { name: 'Copy data from live into uat1' })).toBeEnabled()
        })

        it('hands the button back when the read after a start fails', async () => {
            copyRunsAction
                .mockResolvedValueOnce({ ok: true, runs: [], running: false })
                .mockRejectedValue(new Error('network'))
            render(summary())
            await settle()

            fireEvent.click(screen.getByRole('button', { name: 'Copy data from live into uat1' }))
            fireEvent.change(screen.getByLabelText('Type uat1 to confirm'), { target: { value: 'uat1' } })
            fireEvent.click(screen.getByRole('button', { name: 'Copy data' }))
            await settle()
            await settle()

            expect(screen.getByText(/The copies could not be read/)).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Copy data from live into uat1' })).toBeEnabled()
        })

        it('stops polling when it is taken off the page', async () => {
            copyRunsAction.mockResolvedValue({ ok: true, runs: [record()], running: true })
            const { unmount } = render(summary())
            await settle()
            expect(copyRunsAction).toHaveBeenCalledTimes(1)

            unmount()
            await wait(9000)
            expect(copyRunsAction).toHaveBeenCalledTimes(1)
        })
    })
})
