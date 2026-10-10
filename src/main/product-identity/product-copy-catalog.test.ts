/**
 * Fork-only (Pod): the main-process and CLI copy a packaged product can show, scanned from source.
 * It is every English fallback passed to a translate call and every message of a thrown error;
 * errors reach the user through the branded IPC, RPC and CLI error boundaries. Branded for Pod,
 * none of it may still say Orca, except the upstream phrases branding keeps on purpose.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'
import { brandProductName, UPSTREAM_PRODUCT_PHRASE } from '../../shared/product-name-branding'

const repoRoot = join(__dirname, '..', '..', '..')
const PRODUCT_NAME = /\bOrca\b|\bORCA\b/
// Product code names Orca on purpose: the legacy profile import and its prompts.
const NAMES_ORCA_ON_PURPOSE = /^src\/main\/(product-identity|pod)\//
const TRANSLATE_CALLEE = /(^|\.)(translateMain|translate|t)$/
const ERROR_CALLEE = /Error$/

type CatalogEntry = { where: string; text: string }

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src/main', 'src/shared', 'src/cli'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(
      (file) => file.endsWith('.ts') && !/\.(test|spec)\.ts$|test-fixture|\.d\.ts$/.test(file)
    )
    .filter((file) => !NAMES_ORCA_ON_PURPOSE.test(file))
}

/** A literal's text with each `${…}` as a neutral placeholder. */
function literalText(node: ts.Node, source: ts.SourceFile): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => `X${span.literal.text}`)].join('')
  }
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ? [node.left, node.right].map((side) => literalText(side, source) ?? 'X').join('')
    : null
}

function catalogEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const file of sourceFiles()) {
    const text = readFileSync(join(repoRoot, file), 'utf8')
    if (!PRODUCT_NAME.test(text)) {
      continue
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const add = (node: ts.Node | undefined): void => {
      const copy = node ? literalText(node, source) : null
      if (node && copy && PRODUCT_NAME.test(copy)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        entries.push({ where: `${file}:${line + 1}`, text: copy })
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && TRANSLATE_CALLEE.test(node.expression.getText(source))) {
        add(node.arguments[1])
      } else if (ts.isNewExpression(node) && ERROR_CALLEE.test(node.expression.getText(source))) {
        node.arguments?.forEach(add)
      } else if (ts.isThrowStatement(node)) {
        add(node.expression)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return entries
}

describe('main-process and CLI copy in a product build', () => {
  const pod = { displayName: 'Pod', cliName: 'podx' }
  const entries = catalogEntries()

  it('scans the copy that reaches users', () => {
    expect(entries.length).toBeGreaterThan(250)
    expect(entries.some(({ text }) => text.includes('non-Orca command'))).toBe(true)
  })

  it('names the product everywhere except allowlisted upstream phrases', () => {
    const leaks = entries
      .map(({ where, text }) => ({ where, branded: brandProductName(text, pod) }))
      .filter(({ branded }) => PRODUCT_NAME.test(branded.replace(UPSTREAM_PRODUCT_PHRASE, '')))
      .map(({ where, branded }) => `${where}: ${branded}`)
    expect(leaks).toEqual([])
  })
})
