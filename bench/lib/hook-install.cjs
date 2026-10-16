// Runs an app's own Claude hook installer (its bundled hook-service chunk) against a throwaway
// HOME, the call the app makes at startup once it has found `claude` and read its version:
// install({ claudeVersion }). Prints the plan and the install status as one JSON line.
//
//   HOME=<throwaway home> node hook-install.cjs <extracted app.asar> <claude version>
//
// Only the process runner is stubbed: the installer is handed the version, so nothing runs
// `claude`. Refuses to start unless os.homedir() is the throwaway HOME the caller passed.
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const [asarDir, claudeVersion] = process.argv.slice(2)
const home = process.env.HOME
if (!home || !home.startsWith('/private/tmp/') || os.homedir() !== home) {
  throw new Error(`refusing: HOME must be a throwaway dir under /private/tmp (got ${home})`)
}
const realLoad = Module._load
Module._load = function load(request, ...rest) {
  if (request === '@orca/process-host') {
    return {
      runProcess: async () => {
        throw new Error('hook-install: no processes')
      }
    }
  }
  return realLoad.call(this, request, ...rest)
}
const chunks = path.join(asarDir, 'out/main/chunks')
const chunk = fs
  .readdirSync(chunks)
  .filter((name) => name.startsWith('hook-service-') && name.endsWith('.js'))
  .map((name) => path.join(chunks, name))
  .find((file) => fs.readFileSync(file, 'utf8').includes('managedHookPlan'))
if (!chunk) {
  throw new Error(`no Claude hook-service chunk in ${chunks}`)
}
const exported = require(chunk)
// The Claude hook service class: the export with install/getStatus/managedHookPlan.
const Service = Object.values(exported).find(
  (value) =>
    typeof value === 'function' &&
    ['install', 'getStatus', 'managedHookPlan'].every(
      (method) => typeof value.prototype?.[method] === 'function'
    )
)
if (!Service) {
  throw new Error(`no hook service class exported by ${chunk}`)
}
const service = new Service()
const plan = service.managedHookPlan({ claudeVersion })
const status = service.install({ claudeVersion })
console.log(JSON.stringify({ chunk: path.relative(asarDir, chunk), plan, status }))
