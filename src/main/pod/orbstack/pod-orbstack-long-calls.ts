// Fork-only (Pod): OrbStack changes that can outlast the runtime socket's 30 s idle timer.
// A machine built without a template takes 15–35 s (orb waits 30 s for an address that may
// never come), a template build about as long, a restart minutes. Classed as long-polls, they
// get the transport's keepalive frames, so a slow change isn't reported as a dead runtime
// while Pod finishes it.
export const POD_ORBSTACK_LONG_METHODS: ReadonlySet<string> = new Set([
  'orbstack.create',
  'orbstack.delete',
  'orbstack.start',
  'orbstack.stop',
  'orbstack.restart',
  'orbstack.setTemplates'
])
