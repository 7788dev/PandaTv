import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const baseline = JSON.parse((await readFile(new URL('../docs/evidence/design-original-sha256.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''))
for (const entry of baseline) {
  const actual = createHash('sha256').update(await readFile(new URL('../design/' + entry.path, import.meta.url))).digest('hex')
  if (actual !== entry.sha256) throw new Error('Design changed: ' + entry.path)
}
console.log(`Design unchanged: ${baseline.length} files`)
