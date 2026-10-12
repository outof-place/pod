// Fork-only (Pod): the effective keybindings a native client shows, and a watch on the file.
import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  KEYBINDING_DEFINITIONS,
  getDefaultBindings,
  getEffectiveKeybindingsForDefinition
} from '../../../shared/keybindings'
import type { PodEffectiveKeybindings } from '../../../shared/pod-keybindings-event'
import { readKeybindingFile } from '../../keybindings/keybinding-file'

/** Pod's own read of the file (not the window's cached snapshot), so a hand edit shows too. */
export function readEffectiveKeybindings(
  path: string,
  platform: NodeJS.Platform = process.platform
): PodEffectiveKeybindings {
  const snapshot = readKeybindingFile(path, platform)
  const actions = KEYBINDING_DEFINITIONS.map((definition) => ({
    id: definition.id,
    scope: definition.scope,
    bindings: getEffectiveKeybindingsForDefinition(definition, platform, snapshot.overrides),
    defaults: getDefaultBindings(definition, platform),
    overridden: Array.isArray(snapshot.overrides[definition.id])
  }))
  const revision = createHash('sha256')
    .update(JSON.stringify(actions.map(({ id, bindings }) => [id, bindings])))
    .digest('hex')
    .slice(0, 16)
  return {
    path: snapshot.path,
    platform: snapshot.platform,
    exists: snapshot.exists,
    revision,
    actions,
    diagnostics: snapshot.diagnostics
  }
}

type Listener = (keybindings: PodEffectiveKeybindings) => void

/** One directory watch for every subscriber, open only while one is; no polling. */
export class PodKeybindingsHub {
  private readonly listeners = new Set<Listener>()
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private revision: string | null = null

  constructor(
    private readonly path: () => string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly settleMs = 50,
    private readonly armMs = 250
  ) {}

  read(): PodEffectiveKeybindings {
    return readEffectiveKeybindings(this.path(), this.platform)
  }

  subscribe(listener: Listener, onError: (error: unknown) => void): () => void {
    this.listeners.add(listener)
    if (!this.watcher) {
      this.revision = this.read().revision
      const path = this.path()
      const name = basename(path)
      try {
        // Why the directory: editors save by rename, which ends a watch on the file itself.
        this.watcher = watch(dirname(path), (_event, changed) => {
          if (changed === null || changed === name) {
            this.schedule()
          }
        })
        this.watcher.on('error', onError)
        // Why one more read: macOS starts the FSEvents stream asynchronously, so an edit in its first moments is never reported.
        this.schedule(this.armMs)
      } catch (error) {
        onError(error)
      }
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.close()
      }
    }
  }

  private schedule(delayMs = this.settleMs): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      const keybindings = this.read()
      if (keybindings.revision === this.revision) {
        return
      }
      this.revision = keybindings.revision
      for (const listener of this.listeners) {
        listener(keybindings)
      }
    }, delayMs)
  }

  private close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.revision = null
  }
}
