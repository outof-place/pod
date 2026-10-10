// Parity cases for the computer-use commands and status.
import { computerWorld, ok } from './world.mjs'

export function addComputerAndStatusCases(add) {
  // computer-use.
  const computer = [
    ['computer', 'get-app-state', '--app', 'Safari'],
    ['computer', 'get-app-state', '--app', 'Safari', '--no-screenshot'],
    [
      'computer',
      'get-app-state',
      '--app',
      'com.apple.Safari',
      '--window-id',
      '77',
      '--restore-window'
    ],
    ['computer', 'get-app-state', '--app', 'Safari', '--session', 'sess-9'],
    ['computer', 'click', '--app', 'Safari', '--element-index', '1'],
    [
      'computer',
      'click',
      '--app',
      'Safari',
      '--x',
      '12.5',
      '--y',
      '-3',
      '--click-count',
      '2',
      '--mouse-button',
      'right',
      '--modifiers',
      'CmdOrCtrl+Shift'
    ],
    ['computer', 'click', '--app', 'My App', '--element-index', '0', '--window-index', '2'],
    [
      'computer',
      'scroll',
      '--app',
      'Safari',
      '--element-index',
      '1',
      '--direction',
      'down',
      '--pages',
      '1.5'
    ],
    ['computer', 'press-key', '--app', 'Safari', '--key', 'Return'],
    ['computer', 'press-key', '--app', 'Safari', '--key', '+'],
    ['computer', 'hotkey', '--app', 'Safari', '--key', 'CmdOrCtrl+A', '--window-id', '5'],
    ['computer', 'type-text', '--app', 'Safari', '--text', "it's done"],
    ['computer', 'paste-text', '--app', 'Safari', '--text', 'x'],
    ['computer', 'set-value', '--app', 'Safari', '--element-index', '1', '--value', ''],
    ['computer', 'list-apps'],
    ['computer', 'list-windows', '--app', 'Safari'],
    ['computer', 'capabilities']
  ]
  for (const argv of computer) {
    add(argv.join(' '), argv)
    add(`${argv.join(' ')} --json`, [...argv, '--json'])
  }
  for (const [name, argv] of [
    ['computer click without target falls back', ['computer', 'click', '--app', 'Safari']],
    [
      'computer click bad modifiers falls back',
      ['computer', 'click', '--app', 'S', '--element-index', '1', '--modifiers', 'A']
    ],
    [
      'computer press-key combo falls back',
      ['computer', 'press-key', '--app', 'S', '--key', 'Cmd+A']
    ],
    ['computer hotkey single falls back', ['computer', 'hotkey', '--app', 'S', '--key', 'A']],
    [
      'computer type-text stdin falls back',
      ['computer', 'type-text', '--app', 'S', '--text-stdin']
    ],
    [
      'computer x exponent falls back',
      ['computer', 'click', '--app', 'S', '--x', '1e3', '--y', '2']
    ],
    [
      'computer both window flags falls back',
      ['computer', 'get-app-state', '--app', 'S', '--window-id', '1', '--window-index', '2']
    ]
  ]) {
    add(name, argv)
  }
  const appState = (patch) => ({ responses: { 'computer.getAppState': ok(patch) } })
  const base = computerWorld()['computer.getAppState'][0].result
  add(
    'computer state scale 1.25 no bundle',
    ['computer', 'get-app-state', '--app', 'S'],
    appState({
      ...base,
      snapshot: {
        ...base.snapshot,
        app: { name: 'X', bundleId: null, pid: 1 },
        focusedElementId: null,
        truncation: { truncated: true, maxNodes: 500 }
      },
      screenshot: { ...base.screenshot, scale: 1.25 }
    })
  )
  add(
    'computer state scale 0.3333 saved',
    ['computer', 'get-app-state', '--app', 'S'],
    appState({
      ...base,
      screenshot: { format: 'png', width: 1, height: 2, scale: 1 / 3, path: '/tmp/x.png' },
      screenshotStatus: { state: 'captured' }
    })
  )
  add(
    'computer state skipped',
    ['computer', 'get-app-state', '--app', 'S', '--json'],
    appState({
      ...base,
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
    })
  )
  add(
    'computer state failed',
    ['computer', 'get-app-state', '--app', 'S'],
    appState({
      ...base,
      screenshot: null,
      screenshotStatus: {
        state: 'failed',
        code: 'permission_denied',
        message: 'Screen Recording is off'
      }
    })
  )
  add('computer action no metadata', ['computer', 'click', '--app', 'S', '--element-index', '1'], {
    responses: {
      'computer.click': ok({
        ...base,
        screenshotStatus: { state: 'failed', code: 'c', message: 'm' }
      })
    }
  })
  add(
    'computer server invalid_argument',
    ['computer', 'click', '--app', 'S', '--element-index', '1'],
    {
      responses: {
        'computer.click': [
          { error: { code: 'invalid_argument', message: 'Element index 1 is stale' } }
        ]
      }
    }
  )
  add('computer server app_not_found steps', ['computer', 'get-app-state', '--app', 'Gmail'], {
    responses: {
      'computer.getAppState': [
        {
          error: {
            code: 'app_not_found',
            message: 'No app named Gmail',
            data: { nextSteps: ['List apps'] }
          }
        }
      ]
    }
  })

  // One-call browser handlers.
  for (const argv of [
    ['viewport', '--width', '390', '--height', '844', '--scale', '3', '--mobile'],
    ['viewport', '--width', '1280.5', '--height', '800'],
    ['set', 'device', '--name', 'iPhone 12'],
    ['set', 'offline', '--state', 'on'],
    ['set', 'offline'],
    ['set', 'headers', '--headers', '{"x-a":"1"}'],
    ['set', 'credentials', '--user', 'u', '--pass', ''],
    ['set', 'media', '--color-scheme', 'dark'],
    ['mouse', 'move', '--x', '10.5', '--y', '-2'],
    ['mouse', 'down', '--button', 'right'],
    ['mouse', 'up'],
    ['mouse', 'wheel', '--dy', '300', '--dx', '0'],
    ['mouse', 'wheel', '--dy', '-120'],
    ['scrollintoview', '--element', '@e4'],
    ['get', '--what', 'text', '--element', '@e1'],
    ['is', '--what', 'visible', '--element', '@e1'],
    ['inserttext', '--text', 'abc'],
    ['select', '--element', '@e5', '--value', 'b'],
    ['check', '--element', '@e6'],
    ['uncheck', '--element', '@e6'],
    ['highlight', '--selector', '#main'],
    ['clipboard', 'read'],
    ['clipboard', 'write', '--text', 'hi'],
    ['dialog', 'accept', '--text', 'yes'],
    ['dialog', 'dismiss']
  ]) {
    add(argv.join(' '), argv)
    add(`${argv.join(' ')} --json`, [...argv, '--json'])
  }
  add('viewport negative falls back', ['viewport', '--width', '-1', '--height', '2'])
  add('get object result', ['get', '--what', 'box', '--element', '@e1'], {
    responses: { 'browser.get': ok({ x: 1, y: [2] }) }
  })
  add('is object result', ['is', '--what', 'x', '--element', '@e1'], {
    responses: { 'browser.is': ok({ a: 1 }) }
  })
  add('get undefined result', ['get', '--what', 'x'], { responses: { 'browser.get': [{}] } })

  // status: reads orca-runtime.json and probes status.get itself.
  const status = (result) => ({ responses: { 'status.get': ok(result) } })
  const ready = {
    runtimeId: 'rt-parity-0001',
    graphStatus: 'ready',
    desktopWindowStatus: 'available',
    appVersion: '0.0.1-test',
    capabilities: ['a', 'b']
  }
  for (const [name, extra] of [
    ['status ready', status(ready)],
    [
      'status window closed',
      status({
        ...ready,
        graphStatus: 'starting',
        desktopWindowStatus: 'openable',
        capabilities: []
      })
    ],
    [
      'status legacy window id',
      status({
        runtimeId: 'rt-parity-0001',
        graphStatus: 'ready',
        authoritativeWindowId: 3,
        appVersion: ''
      })
    ],
    ['status remote reconnecting', status({ ...ready, remoteControl: { state: 'reconnecting' } })],
    ['status remote awaiting', status({ ...ready, remoteControl: { state: 'awaiting_ready' } })],
    [
      'status remote ready',
      status({ ...ready, remoteControl: { state: 'ready' }, degradations: [{ id: 'x' }] })
    ],
    [
      'status rpc failure',
      { responses: { 'status.get': [{ error: { code: 'boom', message: 'no' } }] } }
    ],
    ['status closed', { responses: { 'status.get': [{ close: true }] } }],
    ['status not running', { env: { ORCA_USER_DATA_PATH: '/nonexistent/podx-parity' } }],
    [
      'status stale no transports',
      {
        userData: {
          'orca-runtime.json': '{"runtimeId":"x","pid":1,"transports":[],"authToken":"t"}'
        }
      }
    ],
    [
      'status stale empty token',
      {
        userData: {
          'orca-runtime.json':
            '{"runtimeId":"x","pid":__PID__,"transports":[{"kind":"unix","endpoint":"__SOCK__"}],"authToken":""}'
        }
      }
    ],
    [
      'status dead socket live pid',
      {
        userData: {
          'orca-runtime.json':
            '{"runtimeId":"x","pid":__PID__,"transports":[{"kind":"unix","endpoint":"/tmp/podx-parity-no.sock"}],"authToken":"t"}'
        }
      }
    ],
    [
      'status dead socket dead pid',
      {
        userData: {
          'orca-runtime.json':
            '{"runtimeId":"x","pid":999999,"transports":[{"kind":"unix","endpoint":"/tmp/podx-parity-no.sock"}],"authToken":"t"}'
        }
      }
    ],
    [
      'status no pid',
      {
        userData: {
          'orca-runtime.json':
            '{"runtimeId":"rt-parity-0001","transports":[{"kind":"unix","endpoint":"__SOCK__"}],"authToken":"t"}'
        },
        ...status(ready)
      }
    ],
    ['status null metadata', { userData: { 'orca-runtime.json': 'null' } }],
    ['status garbage metadata', { userData: { 'orca-runtime.json': '{not json' } }],
    ['status number metadata falls back', { userData: { 'orca-runtime.json': '5' } }],
    [
      'status agent session falls back',
      { env: { ORCA_AGENT_SESSION_ID: 'sess-1' }, ...status(ready) }
    ]
  ]) {
    add(name, ['status'], extra)
    add(`${name} --json`, ['status', '--json'], extra)
  }
}
