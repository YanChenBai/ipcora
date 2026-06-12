/**
 * Demo schemas powered by ArkType.
 *
 * ArkType types conform to Standard Schema v1, so they work directly as
 * Ipcora `params`, `output`, and event schemas — no wrappers needed.
 */

import { type } from 'arktype'

// ---- Param schemas --------------------------------------------------------

export const createUserParams = type({
  name: 'string > 0',
  email: 'string.email',
})

export const getUserParams = type({
  id: 'string > 0',
})

export const simulateErrorParams = type({
  type: "'validation' | 'database' | 'unknown' | 'ok'",
})

// ---- Output schemas -------------------------------------------------------

export const userOutput = type({
  id: 'string',
  name: 'string',
  email: 'string',
  createdAt: 'number',
})

// ---- Event schemas --------------------------------------------------------

export const userLoginEvent = type({
  userId: 'string',
  at: 'number',
})
