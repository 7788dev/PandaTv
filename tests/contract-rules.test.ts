import { expect, it } from 'vitest'
import { historyRecord } from '../src/contract/rules'

it('records a finished episode as the next episode with unknown duration', () => {
  expect(historyRecord('db-1', 3, 2700, 2700, true)).toEqual({ id: 'db-1', episode: 4, position: 0, duration: 0 })
})

it('keeps the current episode and duration when it is not finished', () => {
  expect(historyRecord('db-1', 3, 1200.8, 2700, true)).toEqual({ id: 'db-1', episode: 3, position: 1200, duration: 2700 })
})