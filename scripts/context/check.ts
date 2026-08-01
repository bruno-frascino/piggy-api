/**
 * Drift check: re-runs every context/ generator (pure, no disk writes of their own),
 * writes the results into a throwaway temp directory, and compares sha256 hashes against
 * the committed context/manifest.json (ignoring `generatedAt`). Exits 1 and prints the
 * offending artifact names if anything differs. Never writes into the real context/
 * directory. Used by the pre-push hook and CI's context-drift job.
 */
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { stableStringify, writeArtifact, type Manifest } from './lib/manifest.js'
import { generateOpenapi } from './emit-openapi.js'
import { generateApiSurface } from './api-surface.js'
import { generateDataModel } from './data-model.js'
import { generateSymbolIndex } from './symbol-index.js'
import { generateModuleGraph } from './module-graph.js'
import { generateUnusedReport } from './unused.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const COMMITTED_MANIFEST_PATH = path.join(ROOT, 'context', 'manifest.json')

async function buildIntoTempDir(tempContextDir: string): Promise<{
  hashes: Record<string, string>
  architectureViolationCount: number
}> {
  const entries: Record<string, string> = {}

  entries['openapi.json'] = writeArtifact(
    path.join(tempContextDir, 'openapi.json'),
    generateOpenapi().content
  )
  entries['api-surface.md'] = writeArtifact(
    path.join(tempContextDir, 'api-surface.md'),
    generateApiSurface().content
  )
  entries['data-model.md'] = writeArtifact(
    path.join(tempContextDir, 'data-model.md'),
    generateDataModel().content
  )
  entries['symbol-index.json'] = writeArtifact(
    path.join(tempContextDir, 'symbol-index.json'),
    stableStringify(generateSymbolIndex().entries)
  )

  const moduleGraph = await generateModuleGraph()
  entries['module-graph.json'] = writeArtifact(
    path.join(tempContextDir, 'module-graph.json'),
    stableStringify(moduleGraph.result)
  )

  entries['unused.json'] = writeArtifact(
    path.join(tempContextDir, 'unused.json'),
    stableStringify(generateUnusedReport().report)
  )

  return { hashes: entries, architectureViolationCount: moduleGraph.violationCount }
}

async function main(): Promise<void> {
  if (!existsSync(COMMITTED_MANIFEST_PATH)) {
    console.error('context/manifest.json does not exist — run `yarn context:build` first.')
    process.exitCode = 1
    return
  }

  const committed = JSON.parse(readFileSync(COMMITTED_MANIFEST_PATH, 'utf8')) as Manifest
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'piggy-api-context-check-'))

  try {
    const { hashes: freshHashes, architectureViolationCount } = await buildIntoTempDir(tempDir)
    const stale: string[] = []

    for (const [name, entry] of Object.entries(committed.artifacts)) {
      if (freshHashes[name] === undefined) continue // module-graph.md is derived, checked below
      if (freshHashes[name] !== entry.sha256) stale.push(name)
    }
    // module-graph.md is a derived summary of module-graph.json; treat it as stale whenever
    // module-graph.json itself is stale (it's regenerated together by build.ts).
    if (stale.includes('module-graph.json') && committed.artifacts['module-graph.md']) {
      stale.push('module-graph.md')
    }
    for (const name of Object.keys(freshHashes)) {
      if (!(name in committed.artifacts)) stale.push(name)
    }

    let failed = false
    if (stale.length > 0) {
      console.error('context/ is stale. Out-of-date or missing artifacts:')
      for (const name of [...new Set(stale)]) console.error(`  - ${name}`)
      console.error('\nRun `yarn context:build`, then `git add context/` and commit.')
      failed = true
    }
    if (architectureViolationCount > 0) {
      console.error(
        `Found ${architectureViolationCount} architecture rule violation(s). ` +
          'Run `yarn context:build` and inspect context/module-graph.md.'
      )
      failed = true
    }
    if (failed) {
      process.exitCode = 1
    } else {
      console.log('context/ is up to date. ✅')
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

await main()
