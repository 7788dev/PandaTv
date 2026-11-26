import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalize } from '../src/main/data/normalize'
import { MetadataStore } from '../src/main/data/store'

it('keeps recent whole UTF-8 records when the newest record alone exceeds the disk budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'panda-metadata-'))
  try {
    const store = new MetadataStore(dir)
    await store.ready
    const synopsis = '影'.repeat(1_100_000)
    const records = ['1', '2', '3', '4', '5'].map(id => normalize({ id, title: id, intro: id === '5' ? synopsis.repeat(4) : synopsis })!)
    store.set(records)
    await store.flush()
    expect((await stat(join(dir, 'metadata-v1.json'))).size).toBeLessThanOrEqual(12 * 1024 * 1024)
    const restored = new MetadataStore(dir)
    await restored.ready
    expect(restored.values().map(record => record.item.id)).toEqual(['db-2', 'db-3', 'db-4'])
    expect(restored.get('db-4')?.item.synopsis?.length).toBe(synopsis.length)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
