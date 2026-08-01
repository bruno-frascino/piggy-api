/**
 * Emits context/openapi.json — a static snapshot of the live swagger-jsdoc spec object
 * (src/lib/swagger.ts `specs`). Deterministic (sorted keys) so re-running with no code
 * change produces byte-identical output.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { specs } from '../../src/lib/swagger.js'
import { stableStringify, writeArtifact } from './lib/manifest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
export const OUTPUT_PATH = path.join(ROOT, 'context', 'openapi.json')

/** Pure: returns the deterministic JSON content, does not touch disk. */
export function generateOpenapi(): { content: string } {
  return { content: stableStringify(specs) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { content } = generateOpenapi()
  const sha256 = writeArtifact(OUTPUT_PATH, content)
  console.log(`Wrote context/openapi.json (sha256 ${sha256.slice(0, 12)}...)`)
}
