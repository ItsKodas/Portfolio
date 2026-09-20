import type { ReactNode } from 'react'

import styles from './DataTable.module.css'

type Column = {
    key: string
    head: string
    numeric?: boolean
}

type Props = {
    label: string
    columns: Column[]
    rows: Record<string, ReactNode>[]
    empty?: string
}

export function DataTable({ label, columns, rows, empty = 'Nothing here yet.' }: Props) {
    // Column headings over no rows say a table failed to load, which is not what an empty list means
    if (!rows.length) return <p className={styles.empty}>{empty}</p>

    return (
        <div className={styles.wrap}>
            <table className={styles.table} aria-label={label}>
                <thead>
                    <tr>
                        {columns.map(column => (
                            <th key={column.key} scope="col" className={column.numeric ? styles.numeric : undefined}>
                                {column.head}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, index) => (
                        <tr key={index}>
                            {columns.map(column => (
                                <td key={column.key} className={column.numeric ? styles.numeric : undefined}>
                                    {row[column.key]}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
