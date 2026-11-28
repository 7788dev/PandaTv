import { expect, it } from 'vitest'
import { episodeRanges, episodeToPlay, historyRecord, nextEpisode, playableEpisodes } from '../src/contract/rules'

it('records a finished episode as the next episode with unknown duration', () => {
  expect(historyRecord('db-1', 3, 2700, 2700, true)).toEqual({ id: 'db-1', episode: 4, position: 0, duration: 0 })
})

it('keeps the current episode and duration when it is not finished', () => {
  expect(historyRecord('db-1', 3, 1200.8, 2700, true)).toEqual({ id: 'db-1', episode: 3, position: 1200, duration: 2700 })
})

it('uses real episode numbers for ranges, resuming legacy history and advancing', () => {
  const item = { episodes: 103, episodeNumbers: [3, 103] }
  expect(playableEpisodes(item)).toEqual([3, 103])
  expect(episodeRanges(103, item.episodeNumbers).map(r => r.from)).toEqual([1, 101])
  expect([1, 3, 4, 1000].map(n => episodeToPlay(item, n))).toEqual([3, 3, 103, 103])
  expect(nextEpisode(item, 103)).toBeUndefined()
  expect(historyRecord('db-1', 3, 2700, 2700, nextEpisode(item, 3)).episode).toBe(103)
})
