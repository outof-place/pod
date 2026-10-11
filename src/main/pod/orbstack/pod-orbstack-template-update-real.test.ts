// Fork-only (Pod): a newer Claude Code updates the sandbox template in place, so the template keeps
// its machine, MAC and IPv4 (OrbStack 2.2.3 holds a deleted machine's address for about a day).
// Opt-in: POD_E2E_ORBSTACK=1 (real OrbStack, two Claude Code downloads, one machine create).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClaudeReleaseCache, sandboxClaudePlatform } from './pod-orbstack-claude-release'
import { sandboxTemplate } from './pod-orbstack-template-machines'
import { createPodOrbstackTemplates } from './pod-orbstack-templates'
import {
  createOrbstackToolRunner,
  resolveOrbstackToolPaths,
  type OrbstackToolRunner
} from './pod-orbstack-tools'

const enabled = process.platform === 'darwin' && process.env.POD_E2E_ORBSTACK === '1'
const FROM = process.env.POD_E2E_ORBSTACK_CLAUDE_FROM ?? '2.1.295'
const TO = process.env.POD_E2E_ORBSTACK_CLAUDE_TO ?? '2.1.296'

// The machine's network identity, then the Claude Code versions it holds.
const PROBE = `cat /sys/class/net/eth0/address
ip -4 -o addr show dev eth0 | awk '{print $4}'
ls "$HOME/.local/share/claude/versions"`

describe.skipIf(!enabled)('real OrbStack template update', () => {
  it('keeps the template machine, its MAC and its IPv4 across a Claude Code update', async () => {
    const tools = createOrbstackToolRunner(() => resolveOrbstackToolPaths())
    const verbs: string[] = []
    const run: OrbstackToolRunner = (tool, args, options) => {
      verbs.push(`${tool} ${args[0] ?? ''}`)
      return tools(tool, args, options)
    }
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pod-test-template-update-')))
    const templates = createPodOrbstackTemplates({
      run,
      file: join(scratch, 'templates.json'),
      log: (message) => console.info(`[template-update] ${message}`)
    })
    const cache = createClaudeReleaseCache({
      root: join(scratch, 'releases'),
      fetcher: (url, init) => fetch(url, init),
      platform: () => sandboxClaudePlatform()
    })
    // Starts the stopped template to read it, then stops it again.
    const probe = async (name: string): Promise<string[]> => {
      const out = await run('orb', ['run', '-m', name, 'sh', '-c', PROBE], { timeoutMs: 60_000 })
      await run('orb', ['stop', name], { timeoutMs: 120_000 })
      return out.stdout.trim().split('\n')
    }
    try {
      const from = await cache.prepare(FROM)
      const to = await cache.prepare(TO)
      const old = await sandboxTemplate(run, templates, from)
      expect(old).toMatchObject({ state: 'ready', agentVersion: FROM })
      const [mac, ip, ...before] = await probe(old?.name ?? '')
      expect(mac).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/)
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/)
      expect(before).toEqual([FROM])

      verbs.length = 0
      const updated = await sandboxTemplate(run, templates, to)
      expect(updated).toMatchObject({ state: 'ready', agentVersion: TO })
      expect(updated?.name).not.toBe(old?.name)
      expect(templates.list()).toEqual([updated])
      expect(verbs).toContain('orb rename')
      expect(verbs).not.toContain('orb create')
      expect(verbs).not.toContain('orb delete')
      expect((await run('orb', ['info', old?.name ?? '', '--format', 'json'])).code).not.toBe(0)

      const after = await probe(updated?.name ?? '')
      expect(after).toEqual([mac, ip, TO])
      console.info(`[template-update] ${JSON.stringify({ mac, ip, from: FROM, to: TO, verbs })}`)
    } finally {
      await templates.deleteAll()
      const left = (await run('orb', ['list', '--quiet'])).stdout.split('\n')
      rmSync(scratch, { recursive: true, force: true })
      // Template names only: a failed build deletes its own machine.
      expect(left.filter((name) => /^pod-sbx-[0-9a-f]{8}-tmpl$/.test(name))).toEqual([])
    }
  }, 900_000)
})
