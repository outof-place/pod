// Fork-only (Pod): the composite actions pin third-party actions by commit, because Pod's own runner
// keeps _work/_tool between jobs and a moved tag could leave changed tools for the next job.
export const CI_ACTION_PINS = {
  'actions/cache': 'caa296126883cff596d87d8935842f9db880ef25', // v5.1.0
  'actions/setup-node': '249970729cb0ef3589644e2896645e5dc5ba9c38', // v6.5.0
  'pnpm/setup': '84cb39b217b10273981911c288cd62326dc7c6d2' // v2.0.2
}

/** `uses:` for a pinned action, e.g. pinnedAction('actions/cache', '/restore'). */
export function pinnedAction(name, subpath = '') {
  const sha = CI_ACTION_PINS[name]
  if (!sha) {
    throw new Error(`${name} has no pin in CI_ACTION_PINS`)
  }
  return `${name}${subpath}@${sha}`
}
