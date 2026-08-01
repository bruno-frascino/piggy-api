/**
 * Generates context/symbol-index.json: every exported symbol under src/**, with its kind,
 * a one-line signature preview, JSDoc summary (if any), and file/line range. Built with
 * ts-morph so signatures reflect the real TypeScript AST, not regex guesses.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Project, Node, type SourceFile } from 'ts-morph'
import { stableStringify, writeArtifact } from './lib/manifest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
export const OUTPUT_PATH = path.join(ROOT, 'context', 'symbol-index.json')

// app-icon.ts is a large base64 blob — deliberately excluded (see AGENTS.md / Phase 0 item 0e).
const EXCLUDED_FILES = new Set(['app-icon.ts'])

interface SymbolEntry {
  name: string
  kind: string
  file: string
  startLine: number
  endLine: number
  signature: string
  jsdoc: string
}

function getSignaturePreview(node: Node): string {
  const text = node.getText()
  const braceIdx = text.indexOf('{')
  const preview = braceIdx === -1 ? text : text.slice(0, braceIdx)
  return preview.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function getJsDocSummary(node: Node): string {
  const maybeJsDocable = node as unknown as { getJsDocs?: () => { getDescription: () => string }[] }
  if (typeof maybeJsDocable.getJsDocs !== 'function') return ''
  const docs = maybeJsDocable.getJsDocs()
  if (docs.length === 0) return ''
  return docs[0]
    .getDescription()
    .replace(/\s+/g, ' ')
    .trim()
}

function collectSymbols(sourceFile: SourceFile, relPath: string): SymbolEntry[] {
  const entries: SymbolEntry[] = []
  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    for (const declaration of declarations) {
      // Skip declarations that live in a different file (re-exports from node_modules etc.)
      if (declaration.getSourceFile() !== sourceFile) continue
      entries.push({
        name,
        kind: declaration.getKindName(),
        file: relPath,
        startLine: declaration.getStartLineNumber(),
        endLine: declaration.getEndLineNumber(),
        signature: getSignaturePreview(declaration),
        jsdoc: getJsDocSummary(declaration),
      })
    }
  }
  return entries
}

export function generateSymbolIndex(): { entries: SymbolEntry[] } {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
  })

  const sourceFiles = project
    .getSourceFiles(['src/**/*.ts'])
    .filter((sf) => {
      const base = path.basename(sf.getFilePath())
      if (base.endsWith('.test.ts')) return false
      if (EXCLUDED_FILES.has(base)) return false
      return true
    })

  const allEntries: SymbolEntry[] = []
  for (const sourceFile of sourceFiles) {
    const relPath = path.relative(ROOT, sourceFile.getFilePath())
    allEntries.push(...collectSymbols(sourceFile, relPath))
  }

  allEntries.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine)
  return { entries: allEntries }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { entries } = generateSymbolIndex()
  const sha256 = writeArtifact(OUTPUT_PATH, stableStringify(entries))
  console.log(`Wrote context/symbol-index.json (${entries.length} symbols, sha256 ${sha256.slice(0, 12)}...)`)
}
