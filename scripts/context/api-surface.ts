/**
 * Generates context/api-surface.md — a route table: method, full path, auth requirement,
 * validators, and file#line, derived from ts-morph AST walks of src/controllers/**.
 * This is an INDEX with file#line pointers, not a copy of the code — read the real file
 * for implementation details.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Project, SyntaxKind, type CallExpression } from 'ts-morph'
import { writeArtifact } from './lib/manifest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const CONTROLLERS_DIR = path.join(ROOT, 'src', 'controllers')
export const OUTPUT_PATH = path.join(ROOT, 'context', 'api-surface.md')

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])

interface RouteInfo {
  method: string
  fullPath: string
  isProtected: boolean
  validators: string
  file: string
  line: number
}

/** Parse src/controllers/index.ts for `router.use('/prefix', xRoutes)` mount points. */
function loadMountPrefixes(project: Project): Map<string, string> {
  const indexPath = path.join(CONTROLLERS_DIR, 'index.ts')
  const sourceFile = project.addSourceFileAtPath(indexPath)

  const importMap = new Map<string, string>() // local import name -> controller file base name
  for (const imp of sourceFile.getImportDeclarations()) {
    const defaultImport = imp.getDefaultImport()
    if (!defaultImport) continue
    const spec = imp.getModuleSpecifierValue() // e.g. './auth.js'
    const base = spec.replace(/^\.\//, '').replace(/\.js$/, '')
    importMap.set(defaultImport.getText(), base)
  }

  const prefixByFile = new Map<string, string>()
  sourceFile.forEachDescendant((node) => {
    if (!node.isKind(SyntaxKind.CallExpression)) return
    const call = node.asKindOrThrow(SyntaxKind.CallExpression)
    const expr = call.getExpression()
    if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) return
    if (expr.getName() !== 'use') return
    const args = call.getArguments()
    if (args.length !== 2) return
    const [prefixArg, routerArg] = args
    if (!prefixArg.isKind(SyntaxKind.StringLiteral)) return
    const prefix = prefixArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()
    const file = importMap.get(routerArg.getText())
    if (file) prefixByFile.set(file, prefix)
  })
  return prefixByFile
}

/** Does this router file have a file-level `router.use(authenticateToken)`? */
function hasFileLevelAuth(call: CallExpression): boolean {
  const expr = call.getExpression()
  if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) return false
  if (expr.getName() !== 'use') return false
  const args = call.getArguments()
  return args.length === 1 && args[0].getText() === 'authenticateToken'
}

function callMentionsAuth(call: CallExpression): boolean {
  return call
    .getArguments()
    .some((arg) => arg.getText().includes('authenticateToken'))
}

function summarizeValidators(call: CallExpression): string {
  const args = call.getArguments()
  const arrayArg = args.find((a) => a.isKind(SyntaxKind.ArrayLiteralExpression))
  if (!arrayArg) return '—'
  const arr = arrayArg.asKindOrThrow(SyntaxKind.ArrayLiteralExpression)
  const names = arr
    .getElements()
    .map((el) => el.getText().split('(')[0].split('.')[0].trim())
    .filter((n) => n !== 'handleValidationErrors' && n !== 'authenticateToken')
  if (names.length === 0) return '—'
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ')
}

function collectRoutesForFile(
  project: Project,
  filePath: string,
  prefix: string
): RouteInfo[] {
  const sourceFile = project.addSourceFileAtPath(filePath)
  const fileBase = path.basename(filePath)
  const routes: RouteInfo[] = []
  let fileLevelAuth = false

  sourceFile.forEachDescendant((node) => {
    if (!node.isKind(SyntaxKind.CallExpression)) return
    const call = node.asKindOrThrow(SyntaxKind.CallExpression)
    if (hasFileLevelAuth(call)) {
      fileLevelAuth = true
      return
    }
    const expr = call.getExpression()
    if (!expr.isKind(SyntaxKind.PropertyAccessExpression)) return
    const methodName = expr.getName()
    if (!HTTP_METHODS.has(methodName)) return

    const args = call.getArguments()
    const pathArg = args[0]
    if (!pathArg?.isKind(SyntaxKind.StringLiteral)) return
    const subPath = pathArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()
    const line = call.getStartLineNumber()

    routes.push({
      method: methodName.toUpperCase(),
      fullPath: `/api${prefix}${subPath === '/' ? '' : subPath}`,
      isProtected: fileLevelAuth || callMentionsAuth(call),
      validators: summarizeValidators(call),
      file: `src/controllers/${fileBase}`,
      line,
    })
  })

  return routes
}

export function generateApiSurface(): { content: string; routeCount: number } {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
  })
  const prefixByFile = loadMountPrefixes(project)

  const allRoutes: RouteInfo[] = []
  for (const [fileBase, prefix] of prefixByFile) {
    const filePath = path.join(CONTROLLERS_DIR, `${fileBase}.ts`)
    allRoutes.push(...collectRoutesForFile(project, filePath, prefix))
  }

  allRoutes.sort((a, b) => a.fullPath.localeCompare(b.fullPath) || a.method.localeCompare(b.method))

  const lines = [
    '# API surface',
    '',
    '> Generated by `scripts/context/api-surface.ts` — do not hand-edit. Run `yarn context:build`.',
    '',
    '| Method | Path | Auth | Validators | Location |',
    '| ------ | ---- | ---- | ---------- | -------- |',
    ...allRoutes.map(
      (r) =>
        `| ${r.method} | \`${r.fullPath}\` | ${r.isProtected ? '🔒' : '—'} | ${r.validators} | [${r.file}:${r.line}](../${r.file}#L${r.line}) |`
    ),
    '',
  ]

  return { content: lines.join('\n'), routeCount: allRoutes.length }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { content, routeCount } = generateApiSurface()
  const sha256 = writeArtifact(OUTPUT_PATH, content)
  console.log(`Wrote context/api-surface.md (${routeCount} routes, sha256 ${sha256.slice(0, 12)}...)`)
}
