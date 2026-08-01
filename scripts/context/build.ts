/**
 * Runs every context/ generator and writes context/manifest.json (sha256 per artifact).
 * This is the single command agents/CI run after any src/, prisma/, or route change.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeArtifact, writeManifest, stableStringify, type ManifestEntry } from './lib/manifest.js'
import { generateOpenapi, OUTPUT_PATH as OPENAPI_PATH } from './emit-openapi.js'
import { generateApiSurface, OUTPUT_PATH as API_SURFACE_PATH } from './api-surface.js'
import { generateDataModel, OUTPUT_PATH as DATA_MODEL_PATH } from './data-model.js'
import { generateSymbolIndex, OUTPUT_PATH as SYMBOL_INDEX_PATH } from './symbol-index.js'
import {
  generateModuleGraph,
  buildMarkdownSummary,
  JSON_OUTPUT_PATH as MODULE_GRAPH_JSON_PATH,
  MD_OUTPUT_PATH as MODULE_GRAPH_MD_PATH,
} from './module-graph.js'
import { generateUnusedReport, OUTPUT_PATH as UNUSED_PATH } from './unused.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const MANIFEST_PATH = path.join(ROOT, 'context', 'manifest.json')

function relKey(absPath: string): string {
  return path.relative(ROOT, absPath)
}

async function main(): Promise<void> {
  const entries: Record<string, ManifestEntry> = {}
  let hadArchitectureViolations = false

  const openapi = generateOpenapi()
  entries['openapi.json'] = {
    path: relKey(OPENAPI_PATH),
    sha256: writeArtifact(OPENAPI_PATH, openapi.content),
  }

  const apiSurface = generateApiSurface()
  entries['api-surface.md'] = {
    path: relKey(API_SURFACE_PATH),
    sha256: writeArtifact(API_SURFACE_PATH, apiSurface.content),
  }

  const dataModel = generateDataModel()
  entries['data-model.md'] = {
    path: relKey(DATA_MODEL_PATH),
    sha256: writeArtifact(DATA_MODEL_PATH, dataModel.content),
  }

  const symbolIndex = generateSymbolIndex()
  entries['symbol-index.json'] = {
    path: relKey(SYMBOL_INDEX_PATH),
    sha256: writeArtifact(SYMBOL_INDEX_PATH, stableStringify(symbolIndex.entries)),
  }

  const moduleGraph = await generateModuleGraph()
  entries['module-graph.json'] = {
    path: relKey(MODULE_GRAPH_JSON_PATH),
    sha256: writeArtifact(MODULE_GRAPH_JSON_PATH, stableStringify(moduleGraph.result)),
  }
  entries['module-graph.md'] = {
    path: relKey(MODULE_GRAPH_MD_PATH),
    sha256: writeArtifact(
      MODULE_GRAPH_MD_PATH,
      buildMarkdownSummary(moduleGraph.result, moduleGraph.violationCount)
    ),
  }
  if (moduleGraph.violationCount > 0) hadArchitectureViolations = true

  const unused = generateUnusedReport()
  entries['unused.json'] = {
    path: relKey(UNUSED_PATH),
    sha256: writeArtifact(UNUSED_PATH, stableStringify(unused.report)),
  }

  writeManifest(MANIFEST_PATH, entries)

  console.log(`context:build wrote ${Object.keys(entries).length} artifacts + manifest.json`)
  if (hadArchitectureViolations) {
    console.error(
      `⚠ ${moduleGraph.violationCount} architecture rule violation(s) — see context/module-graph.md`
    )
    process.exitCode = 1
  }
}

await main()
