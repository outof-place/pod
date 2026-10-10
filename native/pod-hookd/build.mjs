#!/usr/bin/env node
// Builds pod-hookd into resources/pod-hookd, which the Pod macOS build ships as
// Contents/Resources/pod-hookd/pod-hookd plus the SMAppService agent
// Contents/Library/LaunchAgents/<appId>.acc.hookd.plist (config/pod-hookd-resources.cjs).
// pod-hookd is the warm hook server of outof-place/fasthooks (private): Claude Code's one
// PreToolUse Bash entry, pod-hook-client, asks it over a unix socket and runs `fasthooks pre-bash`
// itself when there is no answer. src/main/pod/acc/acc-services.ts registers every
// <appId>.acc.* agent once Pod owns claude-acc, so this one comes and goes with claude-acc's.
// The agent runs `pod-hookd hookd -only-chained`: until the user switches settings.json to the
// client (`pod-hooks native on` writes the chains-claude-acc marker and kickstarts it) it exits
// at once, and KeepAlive (unsuccessful exits only) leaves it stopped.
//
// The pin is a tag and its commit (native/pod-hookd/pin.json). The source is cloned at that tag
// with gh's credentials, refused unless HEAD is the pinned commit, and built here with Go (cgo,
// POD_ARCH), so nothing prebuilt from outside ships.
//
//   node native/pod-hookd/build.mjs              clone the pinned tag, check the commit, build
//   node native/pod-hookd/build.mjs --from DIR   build a local fasthooks checkout (stamped with its HEAD)
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installDir, STAMP } from '../../config/scripts/pinned-release-asset.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
export const HOOKD_DIR = join(ROOT, 'resources', 'pod-hookd')
const PIN = join(import.meta.dirname, 'pin.json')
const COMMIT = /^[0-9a-f]{40}$/

/** @returns {{ repository: string, tag: string, commit: string }} */
export function readPin(path = PIN) {
  const pin = JSON.parse(readFileSync(path, 'utf8'))
  for (const key of ['repository', 'tag', 'commit']) {
    if (typeof pin[key] !== 'string' || !pin[key]) {
      throw new Error(`pod-hookd pin: "${key}" is missing`)
    }
  }
  if (!COMMIT.test(pin.commit)) {
    throw new Error(`pod-hookd pin: commit ${pin.commit} is not a full sha`)
  }
  return pin
}

const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** The agent's plist: Label <appId>.acc.hookd, started from the bundle, never with HOME paths. */
export function agentPlist(appId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(appId)}.acc.hookd</string>
  <key>BundleProgram</key><string>Contents/Resources/pod-hookd/pod-hookd</string>
  <key>ProgramArguments</key>
  <array><string>pod-hookd</string><string>hookd</string><string>-only-chained</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`
}

function run(cmd, args, options = {}) {
  const done = spawnSync(cmd, args, { encoding: 'utf8', ...options })
  if (done.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')}: ${(done.stderr || done.error?.message || '').trim()}`
    )
  }
  return done.stdout.trim()
}

/** go build's environment for POD_ARCH: cgo (pod-hookd sets thread QoS and the task role). */
export function goEnv(arch, env = process.env) {
  const goarch = arch === 'x64' ? 'amd64' : 'arm64'
  const clang = arch === 'x64' ? 'x86_64' : 'arm64'
  return { ...env, CGO_ENABLED: '1', GOOS: 'darwin', GOARCH: goarch, CC: `clang -arch ${clang}` }
}

/**
 * @param {{ from?: string | null, into?: string, pin?: ReturnType<typeof readPin>, arch?: string,
 *   appId?: string }} [options]
 */
export function buildHookd({
  from = null,
  into = HOOKD_DIR,
  pin = readPin(),
  arch = process.env.POD_ARCH || 'arm64',
  appId = JSON.parse(readFileSync(join(ROOT, 'product', 'identity.json'), 'utf8')).appId
} = {}) {
  const work = mkdtempSync(join(tmpdir(), 'pod-hookd-'))
  try {
    let src = from
    if (!src) {
      const stamp = join(into, STAMP)
      if (existsSync(stamp)) {
        const was = JSON.parse(readFileSync(stamp, 'utf8'))
        if (was.commit === pin.commit && was.arch === arch && was.appId === appId) {
          return { commit: pin.commit, source: 'cached' }
        }
      }
      src = join(work, 'src')
      run('git', [
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--branch',
        pin.tag,
        `https://github.com/${pin.repository}.git`,
        src
      ])
    }
    const commit = run('git', ['-C', src, 'rev-parse', 'HEAD'])
    if (!from && commit !== pin.commit) {
      throw new Error(`${pin.repository} ${pin.tag} is ${commit}, pinned ${pin.commit}`)
    }
    const out = join(work, 'out')
    mkdirSync(join(out, 'LaunchAgents'), { recursive: true })
    run(
      'go',
      [
        'build',
        '-tags',
        'hookd',
        '-trimpath',
        '-ldflags',
        '-s -w',
        '-o',
        join(out, 'pod-hookd'),
        '.'
      ],
      {
        cwd: src,
        env: goEnv(arch)
      }
    )
    writeFileSync(join(out, 'LaunchAgents', `${appId}.acc.hookd.plist`), agentPlist(appId))
    writeFileSync(
      join(out, STAMP),
      `${JSON.stringify({ commit, arch, appId, ...(from ? { from } : { tag: pin.tag }) })}\n`
    )
    installDir(out, into)
    return { commit, source: from ?? `${pin.repository}@${pin.tag}` }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const i = process.argv.indexOf('--from')
  try {
    const { commit, source } = buildHookd({ from: i === -1 ? null : process.argv[i + 1] })
    console.log(`pod-hookd ${commit} from ${source}`)
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(1)
  }
}
