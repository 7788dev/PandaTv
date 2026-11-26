import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FILES = ['health.ts', 'buffer.ts', 'switch-budget.ts', 'alignment.ts'] as const
const ALLOWED = new Set(['0.5', '16', '1000', '86400000'])
const NUMBER = /\b\d[\d_]*(?:\.\d+)?\b/g

export interface RuleLiteralViolation {
  file: string
  line: number
  literal: string
}

export function checkRuleLiterals(root = process.cwd()): RuleLiteralViolation[] {
  const violations: RuleLiteralViolation[] = []
  for (const file of FILES) {
    const path = resolve(root, 'src/shared/rules', file)
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith('//')) return
      for (const match of line.matchAll(NUMBER)) {
        const literal = match[0]
        if (literal.replaceAll('_', '').length < 2) continue
        if (ALLOWED.has(literal.replaceAll('_', ''))) continue
        violations.push({ file, line: index + 1, literal })
      }
    })
  }
  return violations
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('check-rule-literals.cjs')) {
  const violations = checkRuleLiterals()
  if (violations.length === 0) {
    console.log('Rule literal guard passed')
  } else {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line} unexplained literal ${violation.literal}`)
    }
    process.exitCode = 1
  }
}