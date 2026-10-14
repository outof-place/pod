import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claudeAccMessage,
  claudeAccPaths,
  parseClaudeAccSnapshot,
  PodClaudeAccAccounts
} from './acc-claude-accounts'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const SNAPSHOT = {
  generated_at: 1792000000,
  accounts: [
    {
      email: 'a@x',
      active: true,
      usable: false,
      status: 'ok',
      note: 'zostało 0% tygodnia',
      session: { used: 10, resets_at: null },
      weekly: { used: 100, resets_at: 1792100000 }
    },
    {
      email: 'b@x',
      active: false,
      usable: true,
      status: 'needs_login',
      session: null,
      weekly: null
    },
    { email: 'p@x', source: 'profile', usable: false, status: 'ok' },
    { email: '', active: true },
    'not a row'
  ]
}

/**
 * An account's claude-acc state dir whose `python` is a stub accswitch: it logs its argv and
 * answers like the script (`add` waits for SIGTERM when STUB_WAIT is set, as a browser sign-in).
 */
function claudeAcc() {
  const home = mkdtempSync(join(tmpdir(), 'pod-claude-acc-'))
  roots.push(home)
  const paths = claudeAccPaths(home)
  mkdirSync(paths.state, { recursive: true })
  const log = join(home, 'argv.log')
  writeFileSync(join(paths.state, 'status.json'), JSON.stringify(SNAPSHOT))
  const fresh = {
    generated_at: 1792000100,
    accounts: [{ email: 'new@x', active: false, usable: true }]
  }
  writeFileSync(join(home, 'fresh.json'), JSON.stringify(fresh))
  writeFileSync(
    paths.python,
    `#!/bin/sh
echo "$HOME|$USER|$*" >> "${log}"
case "$3" in
  add)
    if [ -n "$STUB_WAIT" ]; then
      trap 'kill $! 2>/dev/null; echo "logowanie przerwane" >&2; exit 130' TERM
      sleep 30 & touch "$STUB_WAIT"; wait
    fi
    echo "dodano new@x"; exit 0 ;;
  login) echo "przeglądarka zalogowała c@x, a nie $4"; exit 1 ;;
  switch) echo "przełączono na $4"; exit 0 ;;
  status) cat "${join(home, 'fresh.json')}"; exit 0 ;;
esac
echo "błąd: nieznane polecenie" >&2; exit 2
`
  )
  chmodSync(paths.python, 0o755)
  const argv = (): string[] => readFileSync(log, 'utf8').trim().split('\n')
  return {
    home,
    paths,
    argv,
    ready: join(home, 'ready'),
    accounts: new PodClaudeAccAccounts(paths)
  }
}

describe('parseClaudeAccSnapshot', () => {
  it('keeps the rows Settings shows and drops what is not an account', () => {
    const state = parseClaudeAccSnapshot(SNAPSHOT)
    expect(state?.generatedAt).toBe(1792000000)
    expect(state?.accounts.map((a) => [a.email, a.active, a.needsSignIn, a.podProfile])).toEqual([
      ['a@x', true, false, false],
      ['b@x', false, true, false],
      ['p@x', false, false, true]
    ])
    expect(state?.accounts[0].weekly).toEqual({ used: 100, resetsAt: 1792100000 })
    expect(state?.accounts[0].note).toBe('zostało 0% tygodnia')
  })

  it('is null for anything but a snapshot', () => {
    expect(parseClaudeAccSnapshot({ accounts: 'no' })).toBeNull()
    expect(parseClaudeAccSnapshot(null)).toBeNull()
  })
})

describe('claudeAccMessage', () => {
  it('is the last line without the CLI prefix', () => {
    expect(claudeAccMessage('one\ntwo\n', '')).toBe('two')
    expect(claudeAccMessage('', 'błąd: inny przebieg trwa\n')).toBe('inny przebieg trwa')
  })
})

describe('PodClaudeAccAccounts', () => {
  it('lists the tick snapshot and says so when claude-acc has none', async () => {
    const { accounts, paths } = claudeAcc()
    expect((await accounts.list()).accounts.map((a) => a.email)).toEqual(['a@x', 'b@x', 'p@x'])
    rmSync(join(paths.state, 'status.json'))
    expect(await accounts.list()).toEqual({ available: false, generatedAt: null, accounts: [] })
  })

  it('adds through `claude-acc add` and shows the fresh status right away', async () => {
    const { accounts, argv, home, paths } = claudeAcc()

    const result = await accounts.add()

    expect(result).toMatchObject({ ok: true, message: 'dodano new@x', cancelled: false })
    expect(result.state.accounts.map((a) => a.email)).toEqual(['new@x'])
    const [addCall, statusCall] = argv()
    expect(addCall).toMatch(new RegExp(`^${home}\\|[^|]+\\|${paths.launcher} accswitch add$`))
    expect(statusCall).toContain('accswitch status --json')
  })

  it('cancels an open sign-in with SIGTERM and refuses a second one meanwhile', async () => {
    const { accounts, ready } = claudeAcc()
    vi.stubEnv('STUB_WAIT', ready)

    const pending = accounts.add()
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 })
    expect(accounts.cancel()).toBe(true)
    const second = await accounts.add()
    const result = await pending

    expect(second.ok).toBe(false)
    expect(second.message).toContain('still open')
    expect(result).toMatchObject({ ok: false, cancelled: true, message: 'logowanie przerwane' })
    expect(accounts.cancel()).toBe(false)
  })

  it('reports the script refusing a sign-in and keeps the tick rows', async () => {
    const { accounts } = claudeAcc()

    const result = await accounts.signInAgain('a@x')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('c@x')
    expect(result.state.accounts.map((a) => a.email)).toEqual(['a@x', 'b@x', 'p@x'])
  })

  it('switches by address only: a flag never reaches accswitch', async () => {
    const { accounts, argv } = claudeAcc()

    expect((await accounts.switchTo('--auto')).ok).toBe(false)
    expect((await accounts.signInAgain('-x@y')).ok).toBe(false)
    const result = await accounts.switchTo('b@x')

    expect(result).toMatchObject({ ok: true, message: 'przełączono na b@x' })
    expect(argv().filter((line) => line.includes('accswitch switch'))).toHaveLength(1)
    expect(argv()[0]).toMatch(/accswitch switch b@x$/)
  })
})
