/**
 * Shared helpers for the context/ generator scripts.
 *
 * Rules that keep generated artifacts drift-check-friendly:
 * - JSON keys are sorted deterministically before hashing/writing.
 * - Line endings are normalized to LF.
 * - `generatedAt` timestamps are stored OUTSIDE the hashed content (in manifest.json only),
 *   never embedded inside an artifact's own bytes — otherwise every rebuild would "drift"
 *   even with no real change.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const GENERATOR_VERSION = 1

/** Recursively sort object keys so JSON.stringify output is deterministic. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/** Deterministic JSON.stringify: sorted keys, 2-space indent, trailing newline, LF endings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2).replace(/\r\n/g, '\n') + '\n'
}

/** Normalize any text content to LF endings with a single trailing newline. */
export function normalizeText(content: string): string {
  const withLf = content.replace(/\r\n/g, '\n')
  return withLf.endsWith('\n') ? withLf : withLf + '\n'
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Write `content` to `filePath`, creating parent directories as needed. Returns its sha256. */
export function writeArtifact(filePath: string, content: string): string {
  const normalized = normalizeText(content)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, normalized, 'utf8')
  return sha256(normalized)
}

export interface ManifestEntry {
  path: string
  sha256: string
}

export interface Manifest {
  generatedAt: string
  generatorVersion: number
  artifacts: Record<string, ManifestEntry>
}

/**
 * Build and write manifest.json from a map of artifact-name -> {relative path, sha256}.
 * `generatedAt` is a real timestamp (excluded from any hash comparisons — check.ts must
 * strip/ignore it when diffing, comparing only `artifacts`).
 */
export function writeManifest(
  manifestPath: string,
  entries: Record<string, ManifestEntry>
): void {
  let generatedAt = new Date().toISOString()
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    const artifactsUnchanged = stableStringify(previous.artifacts) === stableStringify(entries)
    if (previous.generatorVersion === GENERATOR_VERSION && artifactsUnchanged) {
      generatedAt = previous.generatedAt
    }
  }

  const manifest: Manifest = {
    generatedAt,
    generatorVersion: GENERATOR_VERSION,
    artifacts: entries,
  }
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, stableStringify(manifest), 'utf8')
}
