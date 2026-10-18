// The JSON line agent-browser's CLI would send its daemon for an argv, for the verbs agents run
// most. Mirrors agent-browser 0.27's `parse_command` (cli/src/commands.rs); anything outside this
// subset, or any argv the CLI would read differently (global flags, unusual arity), is null and
// keeps going through the CLI process.

export type AgentBrowserDaemonCommand = { id: string; action: string } & Record<string, unknown>

let nextCommandId = 1

function command(action: string, fields: Record<string, unknown> = {}): AgentBrowserDaemonCommand {
  return { id: `p${nextCommandId++}`, action, ...fields }
}

// Rust's `str::parse::<i32>()`: optional sign, ASCII digits, in range.
function parseRustI32(value: string): number | null {
  if (!/^[+-]?\d+$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return parsed >= -2_147_483_648 && parsed <= 2_147_483_647 ? parsed : null
}

// Rust's `BufRead::lines()` joined by '\n', as `eval --stdin` reads its script.
function stdinScript(text: string): string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)).join('\n')
}

function oneSelector(action: string, rest: string[]): AgentBrowserDaemonCommand | null {
  return rest.length === 1 ? command(action, { selector: rest[0] }) : null
}

function snapshotCommand(rest: string[]): AgentBrowserDaemonCommand {
  const fields: Record<string, unknown> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '-i' || arg === '--interactive') {
      fields.interactive = true
    } else if (arg === '-c' || arg === '--compact') {
      fields.compact = true
    } else if (arg === '-C' || arg === '--cursor') {
      fields.cursor = true
    } else if (arg === '-u' || arg === '--urls') {
      fields.urls = true
    } else if (arg === '-d' || arg === '--depth') {
      const depth = rest[i + 1] === undefined ? null : parseRustI32(rest[i + 1])
      if (depth !== null) {
        fields.maxDepth = depth
        i++
      }
    } else if (arg === '-s' || arg === '--selector') {
      if (rest[i + 1] !== undefined) {
        fields.selector = rest[i + 1]
        i++
      }
    }
  }
  return command('snapshot', fields)
}

function scrollCommand(rest: string[]): AgentBrowserDaemonCommand | null {
  const fields: Record<string, unknown> = {}
  let positional = 0
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '-s' || arg === '--selector') {
      if (rest[i + 1] === undefined) {
        return null
      }
      fields.selector = rest[i + 1]
      i++
    } else if (!arg.startsWith('-')) {
      if (positional === 0) {
        fields.direction = arg
      } else if (positional === 1) {
        const amount = parseRustI32(arg)
        if (amount !== null) {
          fields.amount = amount
        }
      }
      positional++
    }
  }
  return command('scroll', { direction: 'down', amount: 300, ...fields })
}

const GET_ACTIONS: Record<string, string> = {
  text: 'gettext',
  html: 'innerhtml',
  value: 'inputvalue',
  count: 'count'
}

function getCommand(rest: string[]): AgentBrowserDaemonCommand | null {
  const [what, selector, attribute] = rest
  if (what === 'url' || what === 'title') {
    return rest.length === 1 ? command(what) : null
  }
  if (what === 'attr') {
    return rest.length === 3 ? command('getattribute', { selector, attribute }) : null
  }
  const action = what === undefined ? undefined : GET_ACTIONS[what]
  return action && rest.length === 2 ? command(action, { selector }) : null
}

const IS_ACTIONS: Record<string, string> = {
  visible: 'isvisible',
  enabled: 'isenabled',
  checked: 'ischecked'
}

/**
 * The daemon command for `commandArgs` (no `--session`/`--cdp`/`--json`), or null when only the
 * CLI process can run it. `stdinText` is what the CLI would read for `eval --stdin`.
 */
export function agentBrowserDaemonCommand(
  commandArgs: readonly string[],
  stdinText?: string
): AgentBrowserDaemonCommand | null {
  const [verb, ...rest] = commandArgs
  if (verb === undefined || rest.some(isCliOwnedFlag)) {
    return null
  }
  if (stdinText !== undefined && !(verb === 'eval' && rest[0] === '--stdin')) {
    return null
  }
  switch (verb) {
    case 'click': {
      const newTab = rest.includes('--new-tab')
      const selectors = rest.filter((arg) => arg !== '--new-tab')
      if (selectors.length !== 1) {
        return null
      }
      return command('click', newTab ? { selector: selectors[0], newTab: true } : { selector: selectors[0] })
    }
    case 'dblclick':
    case 'hover':
    case 'focus':
    case 'check':
    case 'uncheck':
      return oneSelector(verb, rest)
    case 'scrollintoview':
    case 'scrollinto':
      return oneSelector('scrollintoview', rest)
    case 'fill':
      return rest.length >= 1 ? command('fill', { selector: rest[0], value: rest.slice(1).join(' ') }) : null
    case 'press':
    case 'key':
      return rest.length === 1 ? command('press', { key: rest[0] }) : null
    case 'keyboard': {
      const [sub, ...words] = rest
      const text = words.join(' ')
      if (!text) {
        return null
      }
      if (sub === 'type') {
        return command('keyboard', { subaction: 'type', text })
      }
      if (sub === 'inserttext' || sub === 'insertText') {
        return command('keyboard', { subaction: 'insertText', text })
      }
      return null
    }
    case 'select': {
      if (rest.length < 2) {
        return null
      }
      const values = rest.slice(1)
      return command('select', { selector: rest[0], values: values.length === 1 ? values[0] : values })
    }
    case 'scroll':
      return scrollCommand(rest)
    case 'get':
      return getCommand(rest)
    case 'is': {
      const action = rest[0] === undefined ? undefined : IS_ACTIONS[rest[0]]
      return action && rest.length === 2 ? command(action, { selector: rest[1] }) : null
    }
    case 'snapshot':
      return snapshotCommand(rest)
    case 'eval':
      if (rest[0] === '--stdin') {
        return stdinText === undefined || rest.length !== 1
          ? null
          : command('evaluate', { script: stdinScript(stdinText) })
      }
      // Why not -b: Rust's strict base64 decoder rejects input Node's lenient one accepts.
      if (rest[0] === '-b' || rest[0] === '--base64') {
        return null
      }
      return command('evaluate', { script: rest.join(' ') })
    case 'back':
    case 'forward':
    case 'reload':
      return rest.length === 0 ? command(verb) : null
    default:
      return null
  }
}

// The CLI's global flags (flags.rs `clean_args`), which it strips from any position, and the
// help and version switches it answers itself (main.rs).
const CLI_OWNED_FLAGS = new Set([
  '--help',
  '-h',
  '--version',
  '-V',
  '--json',
  '--headed',
  '--debug',
  '--ignore-https-errors',
  '--allow-file-access',
  '--hide-scrollbars',
  '--auto-connect',
  '--annotate',
  '--content-boundaries',
  '--confirm-interactive',
  '--no-auto-dialog',
  '-v',
  '--verbose',
  '-q',
  '--quiet',
  '--offline',
  '--quick',
  '--fix',
  '--session',
  '--headers',
  '--executable-path',
  '--cdp',
  '--extension',
  '--init-script',
  '--enable',
  '--profile',
  '--state',
  '--proxy',
  '--proxy-bypass',
  '--args',
  '--user-agent',
  '-p',
  '--provider',
  '--device',
  '--session-name',
  '--color-scheme',
  '--download-path',
  '--max-output',
  '--allowed-domains',
  '--action-policy',
  '--confirm-actions',
  '--config',
  '--engine',
  '--screenshot-dir',
  '--screenshot-quality',
  '--screenshot-format',
  '--idle-timeout',
  '--model'
])

function isCliOwnedFlag(arg: string): boolean {
  return CLI_OWNED_FLAGS.has(arg)
}
