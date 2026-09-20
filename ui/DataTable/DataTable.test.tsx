import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DataTable } from './DataTable'

const columns = [
    { key: 'commit', head: 'commit' },
    { key: 'when', head: 'when', numeric: true },
]
const rows = [
    { commit: 'a3f19c2', when: 'Fri 16:40' },
    { commit: 'd40e7b8', when: 'Thu 11:02' },
]

describe('DataTable', () => {
    it('is a real table with a name', () => {
        render(<DataTable label="Deploy history" columns={columns} rows={rows} />)
        expect(screen.getByRole('table', { name: 'Deploy history' })).toBeInTheDocument()
    })

    it('gives every header cell a scope, so a screen reader can pair a cell with its column', () => {
        render(<DataTable label="Deploy history" columns={columns} rows={rows} />)
        screen.getAllByRole('columnheader').forEach(cell => {
            expect(cell).toHaveAttribute('scope', 'col')
        })
    })

    it('renders a cell for every column of every row', () => {
        render(<DataTable label="Deploy history" columns={columns} rows={rows} />)
        expect(screen.getAllByRole('row')).toHaveLength(3)
        expect(screen.getByText('a3f19c2')).toBeInTheDocument()
        expect(screen.getByText('Thu 11:02')).toBeInTheDocument()
    })

    it('says so when it is empty, instead of showing headers over nothing', () => {
        render(<DataTable label="Deploy history" columns={columns} rows={[]} empty="No deploys yet." />)
        expect(screen.getByText('No deploys yet.')).toBeInTheDocument()
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
    })
})
