// A stand-in for pod-sim in the runtime client's tests: speaks protocol v1 on stdio and answers
// with the shared fixture's results. The test writes an executable wrapper `<dir>/pod-sim` that
// imports this file, and `<dir>/fake.json` beside it (`{mode, ...}`): the helper's environment is
// an allowlist, so the test cannot reach the fake through it. Every spawn appends `<pid> <token>`
// to `<dir>/spawns` and writes the environment it got to `<dir>/env-<spawn>.json`.
//   ok            checks the token from POD_SIM_TOKEN, answers every method
//   unknownBuild  hello reports an unknown build; attachDisplay is unsupported, screenshots via simctl
//   wrongToken    refuses every hello with tokenMismatch
//   wrongProtocol refuses every hello with protocolMismatch
//   crashOnce     the first spawn exits 70 on its first screenshot; later spawns behave like ok
//   crashAlways   exits 70 at start, except on `liveOnSpawns`, which pass hello and exit after `liveMs`
//   hang          never answers a screenshot
//   helperTimeout answers every screenshot with the helper's own `timeout` error
//   reverse       holds the first screenshot until the second arrives, then answers both in reverse
//   noisy         writes junk and an oversized line on stdout before each reply
// `screenshotDelayMs` delays every screenshot answer (any mode).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../../native/pod-sim-macos/Fixtures/protocol-v1.json', import.meta.url),
    'utf8'
  )
)
const dir = dirname(process.argv[1])
const config = JSON.parse(readFileSync(join(dir, 'fake.json'), 'utf8'))
const mode = config.mode ?? 'ok'
appendFileSync(join(dir, 'spawns'), `${process.pid} ${process.env.POD_SIM_TOKEN ?? ''}\n`)
const spawnNumber = readFileSync(join(dir, 'spawns'), 'utf8').trim().split('\n').length
writeFileSync(join(dir, `env-${spawnNumber}.json`), JSON.stringify(process.env))

if (mode === 'crashAlways') {
  if (!(config.liveOnSpawns ?? []).includes(spawnNumber)) {
    process.exit(70)
  }
  setTimeout(() => process.exit(70), config.liveMs ?? 0)
}

const send = (frame) => {
  if (mode === 'noisy') {
    process.stdout.write('not json at all\n')
    process.stdout.write(`${'x'.repeat(1_048_600)}\n`)
  }
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}
const error = (id, code, message) => send({ id, error: { code, message } })
let authenticated = false
let held = null

function screenshot(id, params) {
  if (mode === 'hang') {
    return
  }
  if (mode === 'crashOnce' && spawnNumber === 1) {
    process.exit(70)
  }
  if (mode === 'helperTimeout') {
    return error(id, 'timeout', 'screenshot passed its 8000 ms deadline')
  }
  const shot = { ...fixture.results.screenshot, path: params.path }
  const answer = () =>
    send({
      id,
      result:
        mode === 'unknownBuild' ? { ...fixture.results.screenshotSimctl, path: params.path } : shot
    })
  if (mode === 'reverse' && held === null) {
    held = answer
    return
  }
  const delay = config.screenshotDelayMs ?? 0
  setTimeout(() => {
    answer()
    held?.()
    held = null
  }, delay)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'hello') {
    if (mode === 'wrongToken' || params.token !== process.env.POD_SIM_TOKEN) {
      return error(id, 'tokenMismatch', "the token is not this spawn's")
    }
    if (mode === 'wrongProtocol') {
      return error(id, 'protocolMismatch', 'this helper speaks protocol 2, not 1')
    }
    authenticated = true
    const report =
      mode === 'unknownBuild' ? fixture.results.selftestUnknownBuild : fixture.results.hello
    const { device: _device, fallbacks: _fallbacks, ...hello } = report
    return send({ id, result: { ...hello, helper: { version: '0.1.0', pid: process.pid } } })
  }
  if (!authenticated) {
    return error(id, 'helloRequired', 'send hello first')
  }
  if (method === 'screenshot') {
    return screenshot(id, params)
  }
  if (method === 'attachDisplay') {
    return mode === 'unknownBuild'
      ? error(
          id,
          'unsupported',
          'display: CoreSimulator 1200.1 with SimulatorKit 1050.3 is not in the version table'
        )
      : send({ id, result: fixture.results.attachDisplay })
  }
  if (method === 'displayStats' || method === 'detachDisplay') {
    return send({ id, result: fixture.results.displayStats })
  }
  return error(id, 'unknownMethod', `no method ${method}`)
})
