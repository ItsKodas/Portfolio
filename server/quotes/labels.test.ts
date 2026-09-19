import { describe, expect, it } from 'vitest'

import { Budget, ProjectType, QuoteStatus, Timeline } from '../generated/prisma/enums'
import { BUDGETS, PROJECT_TYPES, STATUSES, TIMELINES } from './labels'

// The form and the database each list the choices; this keeps the two lists the same
describe('the choices match the database enums', () => {
    it.each([
        ['project types', PROJECT_TYPES, ProjectType],
        ['budgets', BUDGETS, Budget],
        ['timelines', TIMELINES, Timeline],
        ['statuses', STATUSES, QuoteStatus],
    ])('%s', (_, labels, enumObject) => {
        expect([...labels]).toEqual(Object.values(enumObject))
    })
})
