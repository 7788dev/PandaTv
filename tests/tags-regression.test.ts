import { expect, it } from 'vitest'
import { DoubanDataSource } from '../src/main/data/douban'

const json = (value: unknown) => new Response(JSON.stringify(value))
const doc = (id: string) => ({ id, type: 'tv', title: 'Documentary ' + id, genres: ['纪录片'], year: '2024' })

it('never asks per-title tag endpoints to confirm a genre', async () => {
  const paths: string[] = []
  const source = new DoubanDataSource({ imageUrl: value => value, fetch: async input => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    if (url.pathname.endsWith('tv/recommend')) return json({ items: [doc('101'), doc('102')], count: 30, total: 2 })
    if (url.pathname.endsWith('movie/recommend')) return json({ items: [], count: 30, total: 0 })
    throw new Error('Unexpected endpoint')
  } })
  const result = await source.channel('doc', { sort: 'hot', genre: '自然' })
  expect(result.items.map(item => item.id)).toEqual(['db-101', 'db-102'])
  expect(paths.every(path => path.endsWith('/recommend'))).toBe(true)
  expect(paths).toHaveLength(2)
})

it('exposes an error when every lane fails instead of showing an empty channel', async () => {
  const source = new DoubanDataSource({ imageUrl: value => value, fetch: async () => new Response('Unavailable', { status: 404 }) })
  await expect(source.channel('doc', { sort: 'hot', genre: '自然' })).rejects.toThrow()
})

it('keeps the film lane when the series lane is unavailable and reports the failure', async () => {
  const warnings: unknown[] = []
  const source = new DoubanDataSource({ imageUrl: value => value, onWarning: value => warnings.push(value), fetch: async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('tv/recommend')) return new Response('Unavailable', { status: 404 })
    return json({ items: [{ ...doc('104'), type: 'movie' }], count: 30, total: 1 })
  } })
  const result = await source.channel('doc', { sort: 'hot', genre: '自然' })
  expect(result.items.map(item => item.id)).toEqual(['db-104'])
  expect(warnings).toHaveLength(1)
  // The failed lane stays open so the next page can retry it.
  expect(result.next).not.toBeNull()
})
