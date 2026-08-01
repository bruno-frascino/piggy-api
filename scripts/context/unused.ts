/**
 * Generates context/unused.json — a knip report of unused files/exports/dependencies,
 * scoped by knip.json (repo root). Informational only: a non-empty report does not fail
 * `yarn context:build` on its own (see check.ts for what IS blocking).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { stableStringify, writeArtifact } from './lib/manifest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
export const OUTPUT_PATH = path.join(ROOT, 'context', 'unused.json')

export function generateUnusedReport(): { report: unknown; issueCount: number } {
  const stdout = execFileSync(
    'npx',
    ['knip', '--reporter', 'json', '--no-exit-code', '--no-progress'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  )
  const report = JSON.parse(stdout) as { issues: unknown[] }
  return { report, issueCount: report.issues?.length ?? 0 }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { report, issueCount } = generateUnusedReport()
  const sha256 = writeArtifact(OUTPUT_PATH, stableStringify(report))
  console.log(`Wrote context/unused.json (${issueCount} files with issues, sha256 ${sha256.slice(0, 12)}...)`)
}
