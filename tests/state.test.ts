import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initialUserState, reduceUser, UserStore } from '../src/main/state'

describe('durable user state', () => {
  it('starts empty, writes changes atomically, survives a new process store', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'panda-state-')), 'user.json')
    const store = new UserStore(path)
    expect(store.get()).toEqual(initialUserState())
    store.dispatch({ type: 'favorite', id: 'db-1292052' })
    store.dispatch({ type: 'history:record', entry: { id: 'db-1292052', episode: 1, position: 42, duration: 120, at: Date.now() } })
    store.dispatch({ type: 'settings', patch: { volume: 0.2, autoNext: false } })
    store.dispatch({ type: 'search:add', query: '三体' })
    expect(new UserStore(path).get()).toEqual(store.get())
    expect(JSON.parse(readFileSync(path, 'utf8')).favorites).toEqual(['db-1292052'])
  })
  it('rejects untrusted invalid fields without mutating the snapshot', () => {
    const original = initialUserState()
    expect(() => reduceUser(original, { type: 'settings', patch: { volume: NaN } })).toThrow('INVALID_INPUT')
    expect(() => reduceUser(original, { type: 'favorite', id: '../../x' })).toThrow()
    expect(() => reduceUser(original, { type: 'history:record', entry: { id: 'db-1', episode: 1, duration: 1, position: 2, at: 0 } })).toThrow()
    expect(original).toEqual(initialUserState())
  })
  it('deduplicates recent searches and only clears the requested collection', () => {
    let state = initialUserState()
    for (let i = 0; i < 12; i++) state = reduceUser(state, { type: 'search:add', query: String(i) })
    state = reduceUser(state, { type: 'favorite', id: 'db-1' })
    state = reduceUser(state, { type: 'search:add', query: '10' })
    expect(state.searches).toHaveLength(8)
    expect(state.searches[0]).toBe('10')
    expect(reduceUser(state, { type: 'history:clear' }).favorites).toEqual(['db-1'])
  })
})
