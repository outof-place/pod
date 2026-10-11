// Fork-only (Pod): the last Computer Use actions agents ran, for the clients' Computer Use pane.
// A 50-row ring in memory only. A row names the action, the app, the caller's target and how it
// went, never what was typed, pasted or set, which keys a hotkey pressed, where a click landed,
// or anything the helper read back (screenshots, window titles, the accessibility tree).
import { getProductIdentity } from '../../product-identity/product-identity'
import type {
  PodComputerActionRow,
  PodComputerActionsEvent
} from '../../../shared/pod-computer-actions-types'

const RING = 50
// Why coalesced: an agent typing or scrolling sends bursts; subscribers get one frame per window,
// so at most 4 a second.
const EMIT_EVERY_MS = 250
const MAX_FIELD = 256

export const POD_COMPUTER_ACTION_METHODS: ReadonlySet<string> = new Set([
  'computer.click',
  'computer.performSecondaryAction',
  'computer.scroll',
  'computer.drag',
  'computer.typeText',
  'computer.pressKey',
  'computer.hotkey',
  'computer.pasteText',
  'computer.setValue'
])

/**
 * On in a Pod build (its product identity) on macOS; upstream Orca records nothing.
 * `POD_COMPUTER_ACTIONS=0|1` overrides the identity, for tests.
 */
export function isPodComputerActionsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  hasIdentity: () => boolean = hasPodProductIdentity
): boolean {
  if (platform !== 'darwin' || env.POD_COMPUTER_ACTIONS === '0') {
    return false
  }
  return env.POD_COMPUTER_ACTIONS === '1' || hasIdentity()
}

function hasPodProductIdentity(): boolean {
  try {
    return getProductIdentity() !== null
  } catch {
    return false
  }
}

type Subscriber = {
  emit: (event: PodComputerActionsEvent) => void
  pending: PodComputerActionRow[]
}

function field(params: unknown, key: 'app' | 'worktree' | 'session'): string | null {
  if (typeof params !== 'object' || params === null || !(key in params)) {
    return null
  }
  const value: unknown = Reflect.get(params, key)
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_FIELD) : null
}

export function createPodComputerActionLog(options?: {
  now?: () => number
  schedule?: (run: () => void, ms: number) => void
  enabled?: () => boolean
}) {
  const now = options?.now ?? Date.now
  const schedule =
    options?.schedule ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms).unref?.()
    })
  // Read once: the identity doesn't change while the runtime runs.
  let enabled: boolean | undefined
  const isEnabled = (): boolean => (enabled ??= (options?.enabled ?? isPodComputerActionsEnabled)())
  // A fixed ring: `next` is where the next row goes, `count` how many it holds.
  const ring: (PodComputerActionRow | undefined)[] = Array.from({ length: RING })
  let next = 0
  let count = 0
  const subscribers = new Set<Subscriber>()
  let seq = 0
  let flushing = false

  const flush = (): void => {
    flushing = false
    for (const subscriber of subscribers) {
      if (subscriber.pending.length > 0) {
        const rows = subscriber.pending
        subscriber.pending = []
        subscriber.emit({ type: 'actions', rows })
      }
    }
  }

  const rows = (): PodComputerActionRow[] => {
    const out: PodComputerActionRow[] = []
    for (let index = 0; index < count; index++) {
      const row = ring[(next - count + index + RING) % RING]
      if (row) {
        out.push(row)
      }
    }
    return out
  }

  return {
    enabled: isEnabled,
    /**
     * Records one finished action into the ring. `params` is read for `app`, `worktree` and
     * `session` only. Without a subscriber nothing else happens: no event, no timer.
     */
    record(method: string, params: unknown, ok: boolean, startedAt: number): void {
      const row: PodComputerActionRow = {
        seq: ++seq,
        at: startedAt,
        action: method.replace(/^computer\./, ''),
        app: field(params, 'app') ?? '',
        worktree: field(params, 'worktree'),
        session: field(params, 'session'),
        ok,
        ms: Math.max(0, now() - startedAt)
      }
      ring[next] = row
      next = (next + 1) % RING
      count = Math.min(count + 1, RING)
      if (subscribers.size === 0) {
        return
      }
      for (const subscriber of subscribers) {
        subscriber.pending.push(row)
      }
      if (!flushing) {
        flushing = true
        schedule(flush, EMIT_EVERY_MS)
      }
    },
    /** The ring so far, oldest first, then every new row. */
    subscribe(emit: (event: PodComputerActionsEvent) => void): {
      seed: PodComputerActionRow[]
      stop: () => void
    } {
      const subscriber: Subscriber = { emit, pending: [] }
      subscribers.add(subscriber)
      return { seed: rows(), stop: () => void subscribers.delete(subscriber) }
    },
    now
  }
}

export type PodComputerActionLog = ReturnType<typeof createPodComputerActionLog>

export const podComputerActionLog = createPodComputerActionLog()

type Handler = (params: never, ...rest: never[]) => unknown

function isHandler(value: unknown): value is Handler {
  return typeof value === 'function'
}

/**
 * The computer.* methods with each action recorded as it finishes; reads (apps, windows, app
 * state, capabilities, permissions) pass through untouched. Without Pod's identity an action runs
 * as upstream's, with nothing recorded.
 */
export function observePodComputerActions<T extends readonly { name: string }[]>(
  methods: T,
  log: PodComputerActionLog = podComputerActionLog
): T {
  const observed = methods.map((method) => {
    const handler: unknown = 'handler' in method ? method.handler : undefined
    if (!POD_COMPUTER_ACTION_METHODS.has(method.name) || !isHandler(handler)) {
      return method
    }
    return {
      ...method,
      handler: async (params: never, ...rest: never[]) => {
        if (!log.enabled()) {
          return handler(params, ...rest)
        }
        const startedAt = log.now()
        try {
          const result = await handler(params, ...rest)
          log.record(method.name, params, true, startedAt)
          return result
        } catch (error) {
          log.record(method.name, params, false, startedAt)
          throw error
        }
      }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each entry keeps its name, permission and params; only an action's handler is swapped for one with the same signature.
  return observed as unknown as T
}
