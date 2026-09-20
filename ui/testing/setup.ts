// Brings in jest-dom's matchers (toBeInTheDocument, toHaveAccessibleName and the rest) and clears the
// rendered tree between tests, so one test's dialog cannot be found by the next.

import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)
