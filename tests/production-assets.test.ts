import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

it('every local production stylesheet dependency is present and visible to Git delivery', () => {
  const visible = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src/renderer'], { encoding: 'utf8' }).trim().split(/\r?\n/))
  const visited = new Set<string>()
  const walk = (path: string) => {
    const file = relative(process.cwd(), path).replaceAll('\\', '/')
    if (visited.has(file)) return
    visited.add(file)
    expect(existsSync(path), `${file} is required by the actual stylesheet graph`).toBe(true)
    expect(visible.has(file), `${file} would be excluded from Git delivery`).toBe(true)
    const css = readFileSync(path, 'utf8')
    for (const match of css.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) walk(resolve(dirname(path), match[1]))
    }
  }
  walk(resolve('src/renderer/styles/index.css'))
  expect(visited.has('src/renderer/styles/tokens.css')).toBe(true)
  expect(visited.size).toBeGreaterThanOrEqual(10)
})
