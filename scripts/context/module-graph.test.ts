import { describe, expect, it } from 'vitest'
import type { ICruiseResult } from 'dependency-cruiser'
import { stableStringify } from './lib/manifest.js'
import { normalizeCruiseResult } from './module-graph.js'

function fixture(baseDir: string, osVersionFound: string): ICruiseResult {
  return {
    modules: [],
    summary: {
      environment: {
        extensionsFound: [],
        nodeVersionFound: 'v22.23.1',
        nodeVersionSupported: '^22',
        osVersionFound,
        transpilersFound: [],
        version: '18.1.0',
      },
      error: 0,
      ignore: 0,
      info: 0,
      optionsUsed: {
        baseDir,
        tsConfig: { fileName: `${baseDir}/tsconfig.json` },
      },
      totalCruised: 0,
      violations: [],
      warn: 0,
    },
  }
}

describe('normalizeCruiseResult', () => {
  it('produces identical output for macOS and Linux checkout metadata', () => {
    const macos = fixture('/Users/developer/piggy-api', 'arm64 darwin@25.5.0')
    const linux = fixture('/home/runner/work/piggy-api/piggy-api', 'x64 linux@6.11.0')

    expect(stableStringify(normalizeCruiseResult(macos))).toBe(
      stableStringify(normalizeCruiseResult(linux))
    )
  })
})