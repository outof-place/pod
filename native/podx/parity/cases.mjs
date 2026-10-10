// Parity cases: argv shapes plus response edge cases on top of the base world.
// Each response list is consumed in order per method; the last entry repeats.
import { addComputerAndStatusCases } from './cases-computer-status.mjs'
import { ok } from './world.mjs'

export function buildCases({ worktree }) {
  const cases = []
  const add = (name, argv, extra = {}) => cases.push({ name, argv, ...extra })

  // Startup paths.
  add('version', ['--version'])
  add('help falls back', ['eval', '--help'])
  add('unknown command falls back', ['evall', '--expression', '1'])
  add('unknown flag falls back', ['eval', '--expresion', '1'])
  add('missing value falls back', ['eval', '--expression'])
  add('positional falls back', ['eval', '1+1'])
  add('pre-command flag falls back', ['--json', 'tab', 'list'])
  add('kill switch', ['tab', 'list'], { env: { POD_NATIVE_CLI: '0' } })
  add('pairing env falls back', ['tab', 'list'], {
    env: { ORCA_PAIRING_CODE: 'bogus' }
  })

  // Browser commands, text and JSON.
  const browser = [
    ['snapshot'],
    ['screenshot'],
    ['screenshot', '--format', 'jpeg'],
    ['goto', '--url', 'https://example.test/next'],
    ['back'],
    ['reload'],
    ['forward'],
    ['eval', '--expression', 'document.title'],
    ['eval', '--expression=--weird'],
    ['scroll', '--direction', 'down', '--amount', '300'],
    ['wait', '--load', 'networkidle'],
    ['wait', '--text', 'Saved', '--timeout', '2000'],
    ['click', '--element', '@e2'],
    ['dblclick', '--element', '@e2'],
    ['fill', '--element', '@e3', '--value', 'hello world'],
    ['type', '--input', 'abc'],
    ['keypress', '--key', 'Enter'],
    ['focus', '--element', '@e1'],
    ['hover', '--element', '@e1'],
    ['clear', '--element', '@e1'],
    ['select-all', '--element', '@e1'],
    ['tab', 'list'],
    ['tab', 'list', '--show-profile'],
    ['tab', 'show', '--page', 'page-1'],
    ['tab', 'current'],
    ['tab', 'switch', '--index', '1'],
    ['tab', 'switch', '--page', 'page-1', '--focus'],
    ['tab', 'create', '--url', 'https://example.test/'],
    ['tab', 'close'],
    ['tab', 'close', '--index', '2'],
    ['open-url', '--url', 'https://example.test/'],
    ['exec', '--command', 'cookies get']
  ]
  for (const argv of browser) {
    add(argv.join(' '), argv)
    add(`${argv.join(' ')} --json`, [...argv, '--json'])
  }

  // Targeting.
  add('eval --worktree all', ['eval', '--expression', '1', '--worktree', 'all'])
  add('eval --worktree active', ['eval', '--expression', '1', '--worktree', 'active'])
  add('eval --worktree path', ['eval', '--expression', '1', '--worktree', `path:${worktree}`])
  add('eval --page', ['eval', '--expression', '1', '--page', 'page-1'])
  add('eval --page --worktree current', [
    'eval',
    '--expression',
    '1',
    '--page',
    'page-1',
    '--worktree',
    'current'
  ])
  add('eval outside any worktree', ['eval', '--expression', '1'], { cwd: '/' })
  add(
    'eval --worktree active outside any worktree',
    ['eval', '--expression', '1', '--worktree', 'active'],
    { cwd: '/' }
  )
  add('eval cwd at worktree root', ['eval', '--expression', '1'], {
    cwd: worktree
  })
  add('worktree.list fails silently for implicit target', ['snapshot'], {
    responses: {
      'worktree.list': [{ error: { code: 'runtime_error', message: 'boom' } }]
    }
  })

  // Result content edge cases.
  const evalResult = (result) => ({
    responses: { 'browser.eval': ok({ result, origin: 'x' }) }
  })
  add('eval unicode', ['eval', '--expression', 'x'], evalResult('zażółć 🚀   "q" \\ \t'))
  add(
    'eval unicode --json',
    ['eval', '--expression', 'x', '--json'],
    evalResult('zażółć 🚀   "q" \\ \t\u0001')
  )
  add('eval empty', ['eval', '--expression', 'x'], evalResult(''))
  add('eval multiline', ['eval', '--expression', 'x'], evalResult('a\nb\r\nc\n'))
  add('eval lone surrogate', ['eval', '--expression', 'x'], {
    responses: {
      'browser.eval': [
        {
          raw: `{"id":"__ID__","ok":true,"result":{"result":"a\\ud800b","origin":"x"},"_meta":{"runtimeId":"rt-parity-0001"}}\n`
        }
      ]
    }
  })
  add('snapshot big numbers --json', ['snapshot', '--json'], {
    responses: {
      'browser.snapshot': ok({
        browserPageId: 'p',
        snapshot: '',
        refs: [1e21, 1.5e-7, -0.25, 2 ** 64, 0],
        url: '',
        title: ''
      })
    }
  })
  add('snapshot integer keys --json', ['snapshot', '--json'], {
    responses: {
      'browser.snapshot': ok({
        b: 1,
        2: 'two',
        a: { 10: 'x', 1: 'y', z: [] },
        browserPageId: 'p',
        snapshot: 's',
        url: 'u',
        title: 't'
      })
    }
  })
  add('tab list empty', ['tab', 'list'], {
    responses: { 'browser.tabList': ok({ tabs: [] }) }
  })
  add('click missing field', ['click', '--element', '@e1'], {
    responses: { 'browser.click': ok({}) }
  })
  add('forward null result', ['forward'], {
    responses: { 'browser.forward': ok(null) }
  })
  add('screenshot padding variants', ['screenshot'], {
    responses: { 'browser.screenshot': ok({ data: 'YWJj', format: 'png' }) }
  })
  add('screenshot one pad', ['screenshot'], {
    responses: { 'browser.screenshot': ok({ data: 'YWI=', format: 'png' }) }
  })
  add('screenshot empty', ['screenshot'], {
    responses: { 'browser.screenshot': ok({ data: '', format: 'png' }) }
  })
  add('extra envelope fields stripped --json', ['tab', 'list', '--json'], {
    responses: {
      'browser.tabList': [{ result: { tabs: [] }, extra: { streaming: true, extraTop: 1 } }]
    }
  })
  add('keepalive before result', ['wait', '--load', 'load'], {
    responses: {
      'browser.wait': [{ result: { waited: true }, keepalives: 3 }]
    }
  })

  // Runtime failures.
  const fail = (method, error, extra = {}) => ({
    responses: { [method]: [{ error, ...extra }] }
  })
  add(
    'rpc error',
    ['click', '--element', '@e9'],
    fail('browser.click', {
      code: 'browser_element_not_found',
      message: 'Element @e9 not found'
    })
  )
  add(
    'rpc error --json',
    ['click', '--element', '@e9', '--json'],
    fail('browser.click', {
      code: 'browser_element_not_found',
      message: 'Element @e9 not found'
    })
  )
  const steps = {
    code: 'browser_no_tab',
    message: 'No browser tab is open.',
    data: {
      nextSteps: ['Run orca tab create', 7, 'Then retry'],
      launchToken: 'secret'
    }
  }
  add('rpc error next steps', ['snapshot'], fail('browser.snapshot', steps))
  add('rpc error next steps --json', ['snapshot', '--json'], fail('browser.snapshot', steps))
  add(
    'rpc error no meta --json',
    ['snapshot', '--json'],
    fail('browser.snapshot', { code: 'x', message: 'y' }, { noMeta: true })
  )
  add(
    'rpc error null runtime --json',
    ['snapshot', '--json'],
    fail('browser.snapshot', { code: 'x', message: 'y' }, { failureMeta: { runtimeId: null } })
  )
  add(
    'rpc runtime_unavailable',
    ['snapshot'],
    fail('browser.snapshot', { code: 'runtime_unavailable', message: 'Gone.' })
  )
  const selectorError = {
    code: 'selector_not_found',
    message: 'No worktree matched.',
    data: { nextSteps: ['from host'], hint: 1 }
  }
  add(
    'selector_not_found with --worktree',
    ['eval', '--expression', '1', '--worktree', 'feature-x'],
    fail('browser.eval', selectorError)
  )
  add(
    'selector_not_found with --worktree --json',
    ['eval', '--expression', '1', '--worktree', 'id:repo-1', '--json'],
    fail('browser.eval', selectorError)
  )
  add(
    'selector_not_found without --worktree',
    ['eval', '--expression', '1'],
    fail('browser.eval', selectorError)
  )
  add(
    'automation conflict token',
    ['tab', 'list'],
    fail('browser.tabList', {
      code: 'runtime_error',
      message:
        "This automation's host changed. Reload it before continuing.: automation_owner_changed"
    })
  )
  add(
    'automation conflict token --json',
    ['tab', 'list', '--json'],
    fail('browser.tabList', {
      code: 'runtime_error',
      message: 'Host changed.: automation_owner_changed'
    })
  )

  // Transport failures.
  add('connection closed', ['click', '--element', '@e1'], {
    responses: { 'browser.click': [{ close: true }] }
  })
  add('connection closed --json', ['click', '--element', '@e1', '--json'], {
    responses: { 'browser.click': [{ close: true }] }
  })
  add('invalid frame', ['click', '--element', '@e1'], {
    responses: { 'browser.click': [{ raw: 'not json\n' }] }
  })
  add('invalid envelope', ['click', '--element', '@e1'], {
    responses: {
      'browser.click': [{ raw: '{"id":"__ID__","ok":true,"result":{}}\n' }]
    }
  })
  add('mismatched id', ['click', '--element', '@e1'], {
    responses: { 'browser.click': [{ result: {}, idMismatch: true }] }
  })
  add('runtime changed', ['click', '--element', '@e1', '--json'], {
    responses: { 'browser.click': [{ result: {}, metaRuntimeId: 'rt-other' }] }
  })
  add('no runtime metadata falls back', ['tab', 'list'], {
    env: { ORCA_USER_DATA_PATH: '/nonexistent/podx-parity' }
  })

  // Terminal and workspace reads.
  const terminal = [
    ['terminal', 'read'],
    ['terminal', 'read', '--terminal', 'term-7'],
    ['terminal', 'read', '--terminal', 'term-7', '--limit', '50'],
    ['terminal', 'read', '--terminal', 'term-7', '--cursor', '120'],
    ['terminal', 'wait', '--terminal', 'term-7', '--for', 'exit', '--timeout-ms', '1000'],
    ['terminal', 'list'],
    ['terminal', 'list', '--worktree', 'active'],
    ['terminal', 'show', '--terminal', 'term-7'],
    ['worktree', 'list'],
    ['worktree', 'list', '--limit', '1'],
    ['worktree', 'show', '--worktree', 'active'],
    ['worktree', 'current']
  ]
  for (const argv of terminal) {
    add(argv.join(' '), argv)
    add(`${argv.join(' ')} --json`, [...argv, '--json'])
  }
  add('terminal read bad cursor falls back', ['terminal', 'read', '--cursor', 'abc'])
  add('terminal read --screen', ['terminal', 'read', '--screen'], {
    responses: {
      'terminal.read': ok({
        terminal: {
          handle: 'h',
          status: 'running',
          source: 'screen',
          nextCursor: null,
          tail: ['x']
        }
      })
    }
  })
  add('terminal read --screen old host', ['terminal', 'read', '--screen'], {
    responses: {
      'terminal.read': ok({
        terminal: {
          handle: 'h',
          status: 'running',
          nextCursor: null,
          tail: []
        }
      })
    }
  })
  add('terminal read limited + draft', ['terminal', 'read'], {
    responses: {
      'terminal.read': ok({
        terminal: {
          handle: 'h',
          status: 'running',
          draft: 'half typed "x"',
          nextCursor: '5',
          latestCursor: '9',
          oldestCursor: '1',
          limited: true,
          truncated: true,
          source: 'screen-unavailable',
          tail: ['a', null, 'c']
        }
      })
    }
  })
  add('terminal wait unsatisfied', ['terminal', 'wait', '--for', 'exit'], {
    responses: {
      'terminal.wait': ok({
        wait: {
          handle: 'h',
          condition: 'exit',
          satisfied: false,
          status: 'running',
          exitCode: null,
          blockedReason: 'codex-trust-workspace'
        }
      })
    }
  })
  add('terminal list visual layouts', ['terminal', 'list'], {
    responses: {
      'terminal.list': ok({
        terminals: [
          {
            handle: 't1',
            title: 'a',
            connected: true,
            worktreePath: '/w',
            preview: 'p'
          }
        ],
        totalCount: 5,
        truncated: true,
        visualLayouts: [
          {
            worktreePath: '/w',
            worktreeId: 'w',
            root: {
              type: 'split',
              direction: 'horizontal',
              first: {
                type: 'group',
                groupId: null,
                tabs: [
                  {
                    tabId: 'tab1',
                    title: null,
                    panes: {
                      type: 'pane',
                      active: true,
                      handle: 't1',
                      title: 'a',
                      tabId: 'tab1',
                      leafId: 'l1'
                    }
                  }
                ]
              },
              second: {
                type: 'group',
                groupId: 'g2',
                tabs: [
                  {
                    tabId: 'tab2',
                    title: 'b',
                    panes: {
                      type: 'pane-split',
                      direction: 'vertical',
                      first: {
                        type: 'pane',
                        active: false,
                        handle: 't2',
                        title: null,
                        tabId: 'tab2',
                        leafId: 'l2'
                      },
                      second: {
                        type: 'pane',
                        active: false,
                        handle: 't3',
                        title: 'c',
                        tabId: 'tab2',
                        leafId: 'l3'
                      }
                    }
                  }
                ]
              }
            }
          }
        ]
      })
    }
  })
  add('terminal list no scope', ['terminal', 'list'], {
    responses: {
      'terminal.list': ok({ terminals: [], totalCount: 0, truncated: false })
    }
  })
  add('worktree list omitted hosts falls back', ['worktree', 'list'], {
    responses: {
      'worktree.list': ok({
        worktrees: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box'] }
      })
    }
  })
  add('worktree list empty', ['worktree', 'list'], {
    responses: {
      'worktree.list': ok({
        worktrees: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: [], omittedHostIds: [] }
      })
    }
  })
  addComputerAndStatusCases(add)
  return cases
}
