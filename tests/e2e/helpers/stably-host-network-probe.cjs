'use strict'
// Fork-only (Pod): required (`electron -r`) into the E2E app's main process before its first line.
// Records each outbound host and fails lookups of Stably's hosts, so a broken gate fails the spec
// without any request reaching Stably.
const dc = require('node:diagnostics_channel')
const dns = require('node:dns')
const fs = require('node:fs')

const logPath = process.env.ORCA_E2E_NETWORK_PROBE_LOG
const STABLY_HOST = /(^|\.)(onorca\.dev|orca\.dev|posthog\.com)$/i

function record(layer, target) {
  try {
    fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, layer, target })}\n`)
  } catch {
    // The probe must never change app behaviour.
  }
}

function blockedLookup(hostname) {
  const error = new Error(`getaddrinfo ENOTFOUND ${hostname} (blocked by the E2E network probe)`)
  error.code = 'ENOTFOUND'
  error.hostname = hostname
  return error
}

if (logPath) {
  const lookup = dns.lookup
  dns.lookup = function probedLookup(hostname, options, callback) {
    record('dns', String(hostname))
    if (STABLY_HOST.test(String(hostname))) {
      const done = typeof options === 'function' ? options : callback
      process.nextTick(() => done(blockedLookup(hostname)))
      return {}
    }
    return lookup.apply(this, arguments)
  }
  const promisesLookup = dns.promises.lookup
  dns.promises.lookup = function probedPromisesLookup(hostname, ...rest) {
    record('dns', String(hostname))
    if (STABLY_HOST.test(String(hostname))) {
      return Promise.reject(blockedLookup(hostname))
    }
    return promisesLookup.call(this, hostname, ...rest)
  }
  dc.subscribe('undici:request:create', ({ request }) => {
    record('fetch', `${request.origin}${request.path}`)
  })
  dc.subscribe('http.client.request.start', ({ request }) => {
    record('http', `${request.protocol}//${request.host}${request.path}`)
  })
}
