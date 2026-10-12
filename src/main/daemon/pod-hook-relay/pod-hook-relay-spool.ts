// Fork-only (Pod): the relay's spool, the C client's (native/pod-agent-hook-macos/src/pod-agent-hook.c):
// a lifecycle event the runtime missed, as one line it replays at its next start.
import { appendFileSync, chmodSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { appendFile, chmod, mkdir, stat, truncate } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PodHookRelayEvent } from './pod-hook-relay-delivery'

const SPOOL_CAP_BYTES = 5_242_880
const SPOOL_MAX_AGE_DAYS = 7
const TOOL_EVENTS = ['"PreToolUse"', '"PostToolUse"', '"PostToolUseFailure"']

type SpoolTarget = { dir: string; file: string }

/** The runtime replays these at its next start (claude-hook.sh spool_hook_event): a lifecycle
 *  event's file beside its endpoint; none for a tool event. */
function spoolTarget(event: PodHookRelayEvent): SpoolTarget | null {
  const { pane, payload } = event
  if (TOOL_EVENTS.some((name) => payload.includes(name)) || !pane.endpoint) {
    return null
  }
  const dir = join(dirname(pane.endpoint), 'spool')
  const id = pane.paneKey.slice(-36).replace(/[/:]/g, '_')
  return { dir, file: join(dir, `pane-${id}.jsonl`) }
}

/** Whole seconds and days, the C client's integer arithmetic: 7.9 days is still 7. */
function spoolTooOld(now: number, mtimeMs: number): boolean {
  return (
    Math.trunc((Math.trunc(now / 1000) - Math.trunc(mtimeMs / 1000)) / 86_400) > SPOOL_MAX_AGE_DAYS
  )
}

function spoolLine(event: PodHookRelayEvent, now: number): Buffer {
  const { pane } = event
  const fields = JSON.stringify({
    paneKey: pane.paneKey,
    tabId: pane.tabId,
    worktreeId: pane.worktreeId,
    env: pane.env,
    version: pane.version,
    launchToken: pane.launchToken,
    source: event.agent,
    receivedAt: Math.floor(now / 1000) * 1000,
    agentProcess: event.agentProcess
  })
  return Buffer.concat([
    Buffer.from(`\n${fields.slice(0, -1)},"payload":`),
    event.payload,
    Buffer.from('}\n')
  ])
}

const spoolChains = new Map<string, Promise<'spooled' | 'skipped'>>()

/** Synchronous: a closing relay spools its backlog before the daemon exits. Behind a write still in
 *  flight for the same file it queues instead, so the file's lines keep their order. */
export function spoolPodHookRelayEvent(
  event: PodHookRelayEvent,
  now: number
): 'spooled' | 'skipped' {
  const target = spoolTarget(event)
  if (!target) {
    return 'skipped'
  }
  if (spoolChains.has(target.file)) {
    void spoolPodHookRelayEventAsync(event, now)
    return 'spooled'
  }
  try {
    mkdirSync(target.dir, { recursive: true, mode: 0o700 })
    chmodSync(target.dir, 0o700)
    let size = 0
    try {
      const info = statSync(target.file)
      if (info.isFile() && spoolTooOld(now, info.mtimeMs)) {
        truncateSync(target.file, 0)
      } else {
        size = info.size
      }
    } catch {
      // No spool yet.
    }
    if (size >= SPOOL_CAP_BYTES) {
      return 'skipped'
    }
    appendFileSync(target.file, spoolLine(event, now), { mode: 0o600 })
    chmodSync(target.file, 0o600)
    return 'spooled'
  } catch {
    // A spool that can't be written loses the event, as the command hook does.
    return 'skipped'
  }
}

async function writeSpool(
  target: SpoolTarget,
  event: PodHookRelayEvent,
  now: number
): Promise<'spooled' | 'skipped'> {
  try {
    await mkdir(target.dir, { recursive: true, mode: 0o700 })
    await chmod(target.dir, 0o700)
    let size = 0
    try {
      const info = await stat(target.file)
      if (info.isFile() && spoolTooOld(now, info.mtimeMs)) {
        await truncate(target.file, 0)
      } else {
        size = info.size
      }
    } catch {
      // No spool yet.
    }
    if (size >= SPOOL_CAP_BYTES) {
      return 'skipped'
    }
    await appendFile(target.file, spoolLine(event, now), { mode: 0o600 })
    await chmod(target.file, 0o600)
    return 'spooled'
  } catch {
    return 'skipped'
  }
}

/** The same off the daemon's loop (a slow disk must not stall every PTY), one write at a time per
 *  file so its lines keep their order. */
export function spoolPodHookRelayEventAsync(
  event: PodHookRelayEvent,
  now: number
): Promise<'spooled' | 'skipped'> {
  const target = spoolTarget(event)
  if (!target) {
    return Promise.resolve('skipped')
  }
  const previous = spoolChains.get(target.file) ?? Promise.resolve('skipped')
  const next = previous.then(() => writeSpool(target, event, now))
  spoolChains.set(target.file, next)
  void next.then(() => {
    if (spoolChains.get(target.file) === next) {
      spoolChains.delete(target.file)
    }
  })
  return next
}
