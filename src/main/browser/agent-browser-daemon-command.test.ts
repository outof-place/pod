import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentBrowserDaemonCommand } from './agent-browser-daemon-command'

// The oracle is agent-browser's own CLI: it runs against a stand-in daemon that records the line
// the CLI sends, and the translation must equal it (ids aside).
const BINARY = join(
  process.cwd(),
  'node_modules',
  'agent-browser',
  'bin',
  `agent-browser-${process.platform}-${process.arch}`
)
const VERSION: string = JSON.parse(
  readFileSync(join(process.cwd(), 'node_modules', 'agent-browser', 'package.json'), 'utf8')
).version
const SESSION = 'parity'
const runnable = process.platform !== 'win32' && existsSync(BINARY)

let directory = ''
let server: Server | null = null
const received: string[] = []

beforeAll(async () => {
  if (!runnable) {
    return
  }
  // Why /tmp: a unix socket path must stay under 104 bytes.
  directory = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'abp-'))
  writeFileSync(join(directory, `${SESSION}.version`), VERSION)
  server = createServer((socket) => {
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        received.push(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        socket.write(`${JSON.stringify({ success: true, data: null, error: null })}\n`)
        newline = buffered.indexOf('\n')
      }
    })
  })
  await new Promise<void>((resolve) => server!.listen(join(directory, `${SESSION}.sock`), resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function cliLine(args: string[], stdin?: string): Promise<Record<string, unknown>> {
  received.length = 0
  return new Promise((resolve, reject) => {
    const child = execFile(
      BINARY,
      ['--session', SESSION, ...args, '--json'],
      { env: { PATH: '/usr/bin:/bin', HOME: directory, AGENT_BROWSER_SOCKET_DIR: directory } },
      (error, stdout) => {
        const line = received.at(-1)
        if (!line) {
          reject(new Error(`the CLI sent nothing: ${error?.message ?? ''} ${stdout}`))
          return
        }
        const sent: Record<string, unknown> = JSON.parse(line)
        const { id: _id, ...command } = sent
        resolve(command)
      }
    )
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

function translated(args: string[], stdin?: string): Record<string, unknown> | null {
  const command = agentBrowserDaemonCommand(args, stdin)
  if (!command) {
    return null
  }
  const { id: _id, ...rest } = command
  return rest
}

const PARITY_CASES: { args: string[]; stdin?: string }[] = [
  { args: ['click', '@e3'] },
  { args: ['click', '#save', '--new-tab'] },
  { args: ['dblclick', '@e1'] },
  { args: ['hover', 'a.more'] },
  { args: ['focus', '@e7'] },
  { args: ['check', '#agree'] },
  { args: ['uncheck', '#agree'] },
  { args: ['scrollintoview', '#footer'] },
  { args: ['scrollinto', '#footer'] },
  { args: ['fill', '#name', 'hello', 'world'] },
  { args: ['press', 'Enter'] },
  { args: ['key', 'Tab'] },
  { args: ['keyboard', 'type', 'hi there'] },
  { args: ['keyboard', 'inserttext', 'x y'] },
  { args: ['keyboard', 'insertText', 'z'] },
  { args: ['select', '#menu', 'one'] },
  { args: ['select', '#menu', 'one', 'two'] },
  { args: ['scroll'] },
  { args: ['scroll', 'up', '200'] },
  { args: ['scroll', 'left', '12.5'] },
  { args: ['scroll', '--selector', '.panel', 'down', '400'] },
  { args: ['get', 'title'] },
  { args: ['get', 'url'] },
  { args: ['get', 'text', '@e2'] },
  { args: ['get', 'html', '#x'] },
  { args: ['get', 'value', '#x'] },
  { args: ['get', 'count', 'li'] },
  { args: ['get', 'attr', '@e2', 'contenteditable'] },
  { args: ['is', 'visible', '#x'] },
  { args: ['is', 'enabled', '#x'] },
  { args: ['is', 'checked', '#x'] },
  { args: ['snapshot'] },
  { args: ['snapshot', '-i'] },
  { args: ['snapshot', '-i', '-c', '-d', '3', '-s', 'table.infobox'] },
  { args: ['snapshot', '--interactive', '--compact', '--depth', '-2', '--selector', '#a b'] },
  { args: ['snapshot', '-d', 'x'] },
  { args: ['snapshot', '-C', '-u'] },
  { args: ['eval', 'document.title'] },
  { args: ['eval', '1', '+', '2'] },
  { args: ['eval', '--stdin'], stdin: 'const a = 1\r\nreturn a\n\n' },
  { args: ['eval', '--stdin'], stdin: 'no newline' },
  { args: ['back'] },
  { args: ['forward'] },
  { args: ['reload'] }
]

describe.skipIf(!runnable)('agentBrowserDaemonCommand matches the CLI it replaces', () => {
  it.each(PARITY_CASES)('$args', async ({ args, stdin }) => {
    expect(translated(args, stdin)).toEqual(await cliLine(args, stdin))
  })
})

describe('agentBrowserDaemonCommand leaves to the CLI', () => {
  it.each([
    [['wait', '#x']],
    [['open', 'https://example.com']],
    [['screenshot']],
    [['network', 'route', '**/*']],
    [['click', '#a', '--json']],
    [['click', '#a', '--session', 'other']],
    [['click', '--help']],
    [['get', 'box', '#a']],
    [['get', 'attr', '#a']],
    [['click']],
    [['eval', '-b', 'MQ==']],
    [['type', '#a', 'x']]
  ])('%j', (args) => {
    expect(agentBrowserDaemonCommand(args)).toBeNull()
  })

  it('only reads stdin for eval --stdin', () => {
    expect(agentBrowserDaemonCommand(['click', '#a'], 'x')).toBeNull()
  })

  it('gives every command its own id', () => {
    const first = agentBrowserDaemonCommand(['back'])
    const second = agentBrowserDaemonCommand(['back'])
    expect(first?.id).not.toBe(second?.id)
  })
})
