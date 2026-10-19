// Fork-only (Pod): Linear's code builds no path in the user's home, so no Pod write can reach
// Orca.app's ~/.orca/linear* files. Every Linear file goes through podLinearStoreDir().
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_MAIN = join(__dirname, '../..')
const LINEAR_DIRS = [join(SRC_MAIN, 'linear'), __dirname]
const HOME_PATHS = [
  /\bhomedir\b/,
  /['"`/]\.orca\b/,
  /\bgetOrcaUserDataPath\b/,
  /getPath\(\s*['"]home['"]/
]

// Comments may name ~/.orca to say why; code may not.
function isComment(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line)
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(path)
    }
    return /\.tsx?$/.test(entry.name) && !/\.test(-support)?\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('Linear stays out of ~/.orca', () => {
  it('has no home-directory path in Linear’s runtime code', () => {
    const files = LINEAR_DIRS.flatMap(sourceFiles)
    const hits = files.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          !isComment(line) && HOME_PATHS.some((pattern) => pattern.test(line))
            ? [`${relative(SRC_MAIN, path)}:${index + 1}: ${line.trim()}`]
            : []
        )
    )
    expect(files.length).toBeGreaterThan(20)
    expect(hits).toEqual([])
  })

  it('keeps the store in userData', () => {
    const paths = readFileSync(join(SRC_MAIN, 'linear', 'linear-credential-paths.ts'), 'utf8')
    expect(paths).toContain('podLinearStoreDir()')
  })
})
