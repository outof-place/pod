import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { simRunProcess, type SimRun, type SimRunResult } from './sim-command-run'
import { createSimDeviceDriver } from './sim-device-driver'
import type { SimProcessRow } from './sim-process-facts'

const SET = '/private/tmp/pod-sim-test/CoreSimulator/Devices'
const A = '0A0A0A0A-0000-4000-8000-00000000000A'
const B = '0B0B0B0B-0000-4000-8000-00000000000B'
// A device of the default set: simslim scans that set whatever `--set` says.
const FILIPS = 'D714382D-D685-4FBE-AB4D-9B369EF9F348'
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
const TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'
const TOOLS = { simctl: '/x/simctl', simslim: '/x/simslim' }

type Reply = SimRunResult | ((args: readonly string[]) => SimRunResult)

function ok(stdout = '', stderr = '', code = 0): SimRunResult {
  return { ok: true, code, stdout, stderr }
}

/** A scripted simctl and simslim: the first rule whose words all appear in the call answers. */
function fakeTools(rules: [words: string, reply: Reply][] = []) {
  const calls: string[][] = []
  const run: SimRun = async (program, args) => {
    calls.push([program, ...args])
    const line = args.join(' ')
    for (const [words, reply] of rules) {
      if (words.split(' ').every((word) => line.includes(word))) {
        return typeof reply === 'function' ? reply(args) : reply
      }
    }
    return ok()
  }
  return { run, calls }
}

function listing(devices: { udid: string; name: string; state: string }[]): string {
  return JSON.stringify({
    devices: {
      [RUNTIME]: devices.map((device) => ({
        ...device,
        isAvailable: true,
        deviceTypeIdentifier: TYPE,
        dataPath: `${SET}/${device.udid}/data`
      }))
    }
  })
}

function driverWith(rules: [string, Reply][] = [], onDisk: string[] | null = [A, B]) {
  const tools = fakeTools(rules)
  const made: string[] = []
  const driver = createSimDeviceDriver({
    deviceSet: SET,
    run: tools.run,
    tools: async () => TOOLS,
    devicesOnDisk: async () => (onDisk ? new Set(onDisk) : null),
    ensureSet: async (set) => {
      made.push(set)
    }
  })
  return { driver, calls: tools.calls, made }
}

describe('the device driver over simctl in Pod’s own set', () => {
  it('names Pod’s device set in every simctl and simslim call, never the default set', async () => {
    const { driver, calls } = driverWith([
      ['list devices', ok(listing([{ udid: A, name: 'Portivo-Pod-1', state: 'Shutdown' }]))],
      ['create', ok(`${B}\n`)],
      ['clone', ok(JSON.stringify({ udid: B, name: 'Portivo-Pod-3' }))],
      ['launchctl list', ok('123\t0\tUIKitApplication:dev.portivo.mobile[1a2b][rb-legacy]\n')]
    ])
    await driver.observe()
    await driver.create('Portivo-Pod-2', TYPE, RUNTIME)
    await driver.clone(A, 'Portivo-Pod-3')
    await driver.prepare(A, null)
    await driver.boot(A)
    await driver.release(A)
    await driver.reset(A, null)
    await driver.shutDown(A)
    await driver.delete(A)
    expect(calls.length).toBeGreaterThan(10)
    for (const call of calls) {
      expect(call.slice(1, 3), call.join(' ')).toEqual(['--set', SET])
    }
  })

  it('makes Pod’s set before its first simctl call, which refuses a set path that is missing', async () => {
    const { driver, made } = driverWith([['list devices', ok(JSON.stringify({ devices: {} }))]])
    await driver.observe()
    await driver.boot(A)
    expect(made).toEqual([SET])
    // Removed under a running runtime: simctl says so, and the next call makes the set again.
    const gone = driverWith([
      ['list devices', ok('', 'Provided set path does not exist: /private/tmp/x', 1)]
    ])
    await gone.driver.observe()
    await gone.driver.observe()
    expect(gone.made).toEqual([SET, SET])
    const tools = fakeTools()
    const broken = createSimDeviceDriver({
      deviceSet: SET,
      run: tools.run,
      tools: async () => TOOLS,
      devicesOnDisk: async () => new Set([A]),
      ensureSet: async () => {
        throw new Error('EACCES')
      }
    })
    expect(await broken.observe()).toMatchObject({ verdict: 'unknown' })
    expect(tools.calls).toEqual([])
  })

  it('lists the set with each device’s state, model and runtime', async () => {
    const { driver } = driverWith([
      [
        'list devices',
        ok(
          listing([
            { udid: A, name: 'Portivo-Pod-1', state: 'Booted' },
            { udid: B, name: 'Portivo-Pod-2', state: 'Shutting Down' }
          ])
        )
      ]
    ])
    expect(await driver.observe()).toEqual({
      verdict: 'ok',
      // What is on disk rides along: a device the list misses but the disk has is not gone.
      onDisk: [A, B],
      devices: [
        { udid: A, name: 'Portivo-Pod-1', state: 'booted', deviceType: TYPE, runtime: RUNTIME },
        {
          udid: B,
          name: 'Portivo-Pod-2',
          state: 'transitioning',
          deviceType: TYPE,
          runtime: RUNTIME
        }
      ]
    })
  })

  it('answers unknown, not an empty set, when simctl times out, fails or prints garbage', async () => {
    const replies: SimRunResult[] = [
      { ok: false, reason: 'timeout', message: 'simctl ran past 5000 ms' },
      ok('', 'CoreSimulatorService connection became invalid', 1),
      ok('{"devices": 7}')
    ]
    for (const reply of replies) {
      const { driver } = driverWith([['list devices', reply]])
      expect((await driver.observe()).verdict).toBe('unknown')
    }
  })

  it('does not trust an empty list while devices of the set are still on disk', async () => {
    const empty = ok(JSON.stringify({ devices: { [RUNTIME]: [] } }))
    const lying = driverWith([['list devices', empty]], [A])
    expect(await lying.driver.observe()).toMatchObject({ verdict: 'unknown' })
    const honest = driverWith([['list devices', empty]], [])
    expect(await honest.driver.observe()).toEqual({ verdict: 'ok', devices: [], onDisk: [] })
  })

  it('answers unknown when Pod’s set cannot be read, whatever simctl lists', async () => {
    const listed = ok(listing([{ udid: A, name: 'Portivo-Pod-1', state: 'Booted' }]))
    const { driver } = driverWith([['list devices', listed]], null)
    expect(await driver.observe()).toMatchObject({ verdict: 'unknown' })
  })

  it('creates a device and answers simctl’s UDID; a refusal is a failed outcome, not a throw', async () => {
    const made = driverWith([['create', ok(`${B}\n`)]])
    expect(await made.driver.create('Portivo-Pod-2', TYPE, RUNTIME)).toEqual({ ok: true, udid: B })
    expect(made.calls[0]).toEqual([
      '/x/simctl',
      '--set',
      SET,
      'create',
      'Portivo-Pod-2',
      TYPE,
      RUNTIME
    ])
    const refused = driverWith([['create', ok('', 'Invalid runtime: iOS-26-5', 2)]])
    const outcome = await refused.driver.create('Portivo-Pod-2', TYPE, RUNTIME)
    expect(outcome).toMatchObject({ ok: false })
    expect(!outcome.ok && outcome.message).toContain('Invalid runtime')
  })

  it('clones through simslim, whose clone keeps no paths into its source, and reads its JSON', async () => {
    const { driver, calls } = driverWith([
      [
        'clone',
        ok(JSON.stringify({ action: 'clone', udid: B, name: 'Portivo-Pod-3', sourceUdid: A }))
      ]
    ])
    expect(await driver.clone(A, 'Portivo-Pod-3')).toEqual({ ok: true, udid: B })
    // A subcommand's flags before its arguments: simslim 0.12.2 prints {action, udid, sourceUdid}.
    expect(calls[0]).toEqual(['/x/simslim', '--set', SET, 'clone', '--json', A, 'Portivo-Pod-3'])
    // Free text naming UDIDs is not an answer, and a clone that landed outside Pod's set failed.
    const prose = driverWith([['clone', ok(`Cloned ${A} as ${B}\n`)]])
    expect(await prose.driver.clone(A, 'Portivo-Pod-3')).toMatchObject({ ok: false })
    const elsewhere = driverWith([['clone', ok(JSON.stringify({ udid: FILIPS }))]])
    expect(await elsewhere.driver.clone(A, 'Portivo-Pod-3')).toMatchObject({ ok: false })
  })

  it('never hands simslim a UDID that is not a device of Pod’s own set', async () => {
    const { driver, calls } = driverWith([], [A])
    for (const outcome of [
      await driver.prepare(FILIPS, null),
      await driver.clone(FILIPS, 'Portivo-Pod-3'),
      await driver.reset(FILIPS, null)
    ]) {
      expect(outcome).toMatchObject({ ok: false })
      expect(!outcome.ok && outcome.message).toContain('not a device of Pod')
    }
    expect(calls.filter((call) => call[0] === '/x/simslim')).toEqual([])
  })

  it('boots by waiting for the boot to finish, and a device already up is booted', async () => {
    const { driver, calls } = driverWith()
    expect(await driver.boot(A)).toEqual({ ok: true })
    expect(calls.map((call) => call.slice(3))).toEqual([['bootstatus', A, '-b']])
  })

  it('treats shutting down a shut-down device and deleting a deleted one as done', async () => {
    const down = driverWith([
      ['shutdown', ok('', 'Unable to shutdown device in current state: Shutdown', 149)]
    ])
    expect(await down.driver.shutDown(A)).toEqual({ ok: true })
    const gone = driverWith([['delete', ok('', `Invalid device: ${A}`, 164)]])
    expect(await gone.driver.delete(A)).toEqual({ ok: true })
    const stuck = driverWith([['shutdown', ok('', 'CoreSimulatorService timed out', 1)]])
    expect(await stuck.driver.shutDown(A)).toMatchObject({ ok: false })
  })

  it('prepares with simslim: slim, check the slim really holds, then shut down', async () => {
    const { driver, calls } = driverWith()
    expect(await driver.prepare(A, null)).toEqual({ ok: true })
    expect(calls.map((call) => [call[0], ...call.slice(3)])).toEqual([
      ['/x/simslim', 'on', A],
      ['/x/simctl', 'bootstatus', A, '-b'],
      ['/x/simslim', 'verify', A],
      ['/x/simctl', 'shutdown', A]
    ])
  })

  it('fails a prepare whose slim does not verify, and shuts the device down anyway', async () => {
    const { driver, calls } = driverWith([['verify', ok('drift: com.apple.photoanalysisd', '', 1)]])
    const outcome = await driver.prepare(A, null)
    expect(outcome).toMatchObject({ ok: false })
    expect(!outcome.ok && outcome.message).toContain('verify')
    expect(calls.at(-1)?.slice(3)).toEqual(['shutdown', A])
  })

  it('names the fix when simslim is not installed', async () => {
    const tools = fakeTools()
    const driver = createSimDeviceDriver({
      deviceSet: SET,
      run: tools.run,
      tools: async () => ({ simctl: '/x/simctl', simslim: null }),
      devicesOnDisk: async () => new Set([A]),
      ensureSet: async () => undefined
    })
    const outcome = await driver.prepare(A, null)
    expect(outcome).toMatchObject({ ok: false })
    expect(!outcome.ok && outcome.message).toContain('brew install')
    // Nothing booted it; the closing shutdown only makes sure.
    expect(tools.calls.map((call) => call.slice(3))).toEqual([['shutdown', A]])
  })

  it('resets keeping the UDID: shut down, erase, slim again, and leaves it booted', async () => {
    const { driver, calls } = driverWith([
      ['shutdown', ok('', 'Unable to shutdown device in current state: Shutdown', 149)]
    ])
    expect(await driver.reset(A, null)).toEqual({ ok: true })
    expect(calls.map((call) => [call[0], ...call.slice(3)])).toEqual([
      ['/x/simctl', 'shutdown', A],
      ['/x/simctl', 'erase', A],
      ['/x/simslim', 'on', A],
      ['/x/simctl', 'bootstatus', A, '-b'],
      ['/x/simslim', 'verify', A]
    ])
    const failed = driverWith([['erase', ok('', 'Unable to erase contents and settings', 1)]])
    expect(await failed.driver.reset(A, null)).toMatchObject({ ok: false })
  })

  it('applies the app’s slim profile file when one is named', async () => {
    const tools = fakeTools()
    const driver = createSimDeviceDriver({
      deviceSet: SET,
      run: tools.run,
      tools: async () => TOOLS,
      devicesOnDisk: async () => new Set([A]),
      ensureSet: async () => undefined,
      slimProfileFile: (profile) => (profile ? `/profiles/${profile.app.id}.json` : null)
    })
    const profile = {
      app: { id: 'mobile', bundleId: 'dev.portivo.mobile' },
      worktreeRoot: '/Users/dev/portivo'
    }
    await driver.prepare(A, profile)
    expect(tools.calls[0].slice(3)).toEqual(['on', A, '--profile', '/profiles/mobile.json'])
    expect(tools.calls[2].slice(3)).toEqual(['verify', A, '--profile', '/profiles/mobile.json'])
  })

  it('releases by ending the user apps running on the device, never the system’s', async () => {
    const { driver, calls } = driverWith([
      [
        'launchctl list',
        ok(
          [
            '81\t0\tUIKitApplication:dev.portivo.mobile[a1][rb-legacy]',
            '82\t0\tUIKitApplication:com.apple.mobilesafari[b2][rb-legacy]',
            '83\t0\tUIKitApplication:dev.mobile.maestro-driver-iosUITests.xctrunner[c3]',
            '-\t0\tcom.apple.backboardd'
          ].join('\n')
        )
      ]
    ])
    expect(await driver.release(A)).toEqual({ ok: true })
    expect(calls.slice(1).map((call) => call.slice(3))).toEqual([
      ['terminate', A, 'dev.portivo.mobile'],
      ['terminate', A, 'dev.mobile.maestro-driver-iosUITests.xctrunner']
    ])
  })

  const THREE_APPS = [
    '81\t0\tUIKitApplication:dev.portivo.mobile[a1][rb-legacy]',
    '82\t0\tUIKitApplication:dev.portivo.admin[b2][rb-legacy]',
    '83\t0\tUIKitApplication:dev.portivo.crew[c3][rb-legacy]'
  ].join('\n')

  it('ends every app at once under one deadline, so three slow ones fit the release op', async () => {
    let running = 0
    let most = 0
    const run: SimRun = async (_program, args) => {
      if (args.includes('launchctl')) {
        return ok(THREE_APPS)
      }
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running -= 1
      return ok()
    }
    const driver = createSimDeviceDriver({
      deviceSet: SET,
      run,
      tools: async () => TOOLS,
      devicesOnDisk: async () => new Set([A]),
      ensureSet: async () => undefined
    })
    expect(await driver.release(A)).toEqual({ ok: true })
    expect(most).toBe(3)
  })

  it('takes an app that quit meanwhile as ended, and fails the release on any other refusal', async () => {
    const quit = driverWith([
      ['launchctl list', ok(THREE_APPS)],
      [
        'terminate dev.portivo.admin',
        ok(
          '',
          'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=164): found nothing to terminate',
          164
        )
      ]
    ])
    expect(await quit.driver.release(A)).toEqual({ ok: true })
    const stuck = driverWith([
      ['launchctl list', ok(THREE_APPS)],
      ['terminate dev.portivo.crew', ok('', 'CoreSimulatorService connection became invalid', 1)]
    ])
    const outcome = await stuck.driver.release(A)
    expect(outcome).toMatchObject({ ok: false })
    expect(!outcome.ok && outcome.message).toContain('dev.portivo.crew')
    const late = driverWith([
      ['launchctl list', ok(THREE_APPS)],
      [
        'terminate dev.portivo.mobile',
        { ok: false, reason: 'timeout', message: 'simctl ran past 40000 ms' }
      ]
    ])
    expect(await late.driver.release(A)).toMatchObject({ ok: false })
  })
})

describe('the app module’s calls on a device (stage 5), through the same simctl', () => {
  const APP = '/Users/dev/.pod/sim/clients/eu.portivo.app/c118632b.app'

  it('installs, launches on Metro with its arguments and reads the app’s state in Pod’s set only', async () => {
    const { driver, calls } = driverWith([
      ['get_app_container', ok('/x/data/Containers/Bundle/Application/1/Portivo.app\n')],
      ['launchctl list', ok('123\t0\tUIKitApplication:eu.portivo.app[1a2b][rb-legacy]\n')]
    ])
    expect(await driver.appInstalled(A, 'eu.portivo.app')).toBe(true)
    expect(await driver.install(A, APP)).toEqual({ ok: true })
    expect(
      await driver.launch(A, 'eu.portivo.app', [
        '--initialUrl',
        'http://127.0.0.1:8183',
        '-EXDevMenuShowsAtLaunch',
        'NO'
      ])
    ).toEqual({ ok: true })
    expect(await driver.appRunning(A, 'eu.portivo.app')).toBe(true)
    expect(await driver.appRunning(A, 'eu.portivo.operator')).toBe(false)
    expect(await driver.uninstall(A, 'eu.portivo.app')).toEqual({ ok: true })
    for (const call of calls) {
      expect(call.slice(1, 3), call.join(' ')).toEqual(['--set', SET])
    }
    const words = calls.map((call) => call.slice(3).join(' '))
    expect(words).toEqual(
      expect.arrayContaining([
        `get_app_container ${A} eu.portivo.app app`,
        `install ${A} ${APP}`,
        // A running copy is ended first; the arguments reach the app as its process arguments.
        `launch --terminate-running-process ${A} eu.portivo.app --initialUrl http://127.0.0.1:8183 -EXDevMenuShowsAtLaunch NO`,
        `uninstall ${A} eu.portivo.app`
      ])
    )
  })

  it('reads a missing app as not installed, a silent simctl as unknown, and an absent uninstall as done', async () => {
    const missing = driverWith([
      ['get_app_container', ok('', 'No such file or directory', 2)],
      ['uninstall', ok('', 'The application is not installed', 1)]
    ])
    expect(await missing.driver.appInstalled(A, 'eu.portivo.app')).toBe(false)
    expect(await missing.driver.uninstall(A, 'eu.portivo.app')).toEqual({ ok: true })
    const silent = driverWith([
      ['get_app_container', { ok: false, reason: 'timeout', message: 'ran past 15000 ms' }],
      ['launchctl list', { ok: false, reason: 'timeout', message: 'ran past 15000 ms' }]
    ])
    expect(await silent.driver.appInstalled(A, 'eu.portivo.app')).toBe('unknown')
    expect(await silent.driver.appRunning(A, 'eu.portivo.app')).toBe('unknown')
    const failing = driverWith([
      ['install', ok('', 'Failed to install the app: not a simulator build', 1)]
    ])
    const installed = await failing.driver.install(A, APP)
    expect(!installed.ok && installed.message).toContain('not a simulator build')
  })
})

describe.skipIf(process.platform !== 'darwin')(
  'which apps a device has and runs, read on this Mac (stage 5)',
  () => {
    const C = '0C0C0C0C-0000-4000-8000-00000000000C'
    const plist = (bundleId: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`

    /** A set on disk: device A has the Portivo client and another app, device C the client. */
    async function setOnDisk() {
      const set = await realpath(await mkdtemp(join(tmpdir(), 'pod-sim-set-')))
      const apps: Record<string, string> = {}
      const install = async (udid: string, container: string, name: string, bundleId: string) => {
        const app = join(set, udid, 'data', 'Containers', 'Bundle', 'Application', container, name)
        await mkdir(app, { recursive: true })
        await writeFile(join(app, 'Info.plist'), plist(bundleId))
        apps[`${udid} ${bundleId}`] = app
      }
      await install(A, '11111111-1111-4111-8111-111111111111', 'c118632b.app', 'eu.portivo.app')
      await install(A, '22222222-2222-4222-8222-222222222222', 'Other.app', 'com.example.other')
      await install(C, '33333333-3333-4333-8333-333333333333', 'c118632b.app', 'eu.portivo.app')
      await writeFile(
        join(set, A, 'device.plist'),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>name</key><string>Portivo-Pod-1</string><key>UDID</key><string>${A}</string></dict></plist>`
      )
      return { set, apps }
    }

    function driverOver(set: string, rows: SimProcessRow[]) {
      const simctl: string[][] = []
      // plutil runs for real; simctl only answers that it was asked.
      const run: SimRun = async (program, args, options) => {
        if (program === '/usr/bin/plutil') {
          return simRunProcess(program, args, options)
        }
        simctl.push([program, ...args])
        return ok('', 'No such file or directory', 2)
      }
      const driver = createSimDeviceDriver({
        deviceSet: set,
        run,
        tools: async () => TOOLS,
        ensureSet: async () => undefined,
        processes: { startOf: async () => 'unknown', table: async () => rows }
      })
      return { driver, simctl }
    }

    it('answers installed and running from the set’s folders and the process table, without simctl', async () => {
      const { set, apps } = await setOnDisk()
      try {
        const portivoOnA = `${apps[`${A} eu.portivo.app`]}/Portivo --initialUrl http://127.0.0.1:8183`
        const { driver, simctl } = driverOver(set, [
          { pid: 10, ppid: 1, command: '/sbin/launchd' },
          { pid: 11, ppid: 9, command: portivoOnA }
        ])
        expect(await driver.appInstalled(A, 'eu.portivo.app')).toBe(true)
        expect(await driver.appInstalled(A, 'com.example.missing')).toBe(false)
        expect(await driver.appRunning(A, 'eu.portivo.app')).toBe(true)
        // Installed is not running.
        expect(await driver.appRunning(A, 'com.example.other')).toBe(false)
        // The name the app reports to Metro's inspector, from CoreSimulator's record of the device.
        expect(await driver.deviceName(A)).toBe('Portivo-Pod-1')
        expect(await driver.deviceName(C)).toBeNull()
        expect(simctl).toEqual([])
      } finally {
        await rm(set, { recursive: true, force: true })
      }
    })

    it('does not take the same app running on another device for this one', async () => {
      const { set, apps } = await setOnDisk()
      try {
        const portivoOnC = `${apps[`${C} eu.portivo.app`]}/Portivo --initialUrl http://127.0.0.1:8184`
        const { driver } = driverOver(set, [{ pid: 12, ppid: 9, command: portivoOnC }])
        expect(await driver.appRunning(A, 'eu.portivo.app')).toBe(false)
        expect(await driver.appRunning(C, 'eu.portivo.app')).toBe(true)
      } finally {
        await rm(set, { recursive: true, force: true })
      }
    })

    it('asks simctl when the device has no data folder on this Mac', async () => {
      const { set } = await setOnDisk()
      try {
        const { driver, simctl } = driverOver(set, [])
        expect(await driver.appInstalled(B, 'eu.portivo.app')).toBe(false)
        expect(simctl.map((call) => call.slice(3).join(' '))).toEqual([
          `get_app_container ${B} eu.portivo.app app`
        ])
      } finally {
        await rm(set, { recursive: true, force: true })
      }
    })
  }
)
