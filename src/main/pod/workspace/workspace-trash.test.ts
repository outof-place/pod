import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceTrash } from './workspace-trash'

describe('workspace trash', () => {
  let home: string

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'pod-ws-trash-')))
  })

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const folder = (name: string, content: string): string => {
    const path = join(home, 'work', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'file.txt'), content)
    return path
  }

  it('renames into ~/.Trash, keeps same-named folders apart and puts them back', async () => {
    const osTrash = vi.fn(async () => {})
    const trash = createWorkspaceTrash(home, osTrash)
    const first = await trash.move(folder('wt', 'one'))
    const second = await trash.move(folder('wt', 'two'))
    expect(first).toBe(join(home, '.Trash', 'wt'))
    expect(second).not.toBe(first)
    expect(readFileSync(join(second ?? '', 'file.txt'), 'utf8')).toBe('two')
    expect(osTrash).not.toHaveBeenCalled()

    await expect(trash.putBack(first ?? '', join(home, 'work', 'wt'))).resolves.toBeUndefined()
    expect(readFileSync(join(home, 'work', 'wt', 'file.txt'), 'utf8')).toBe('one')
    // Something took its place: the second one stays in the Trash.
    await expect(trash.putBack(second ?? '', join(home, 'work', 'wt'))).rejects.toThrow(
      /already exists/
    )
    expect(existsSync(second ?? '')).toBe(true)
  })
})
