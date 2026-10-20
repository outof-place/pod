// Fork-only (Pod): the macOS native helpers build-native-for-platform.mjs builds in parallel, one
// pnpm script each. Its test reads the same list, so a helper added here can't leave it behind.
export const MACOS_NATIVE_BUILD_SCRIPTS = Object.freeze([
  'build:computer-macos',
  'build:keyboard-layout-macos',
  'build:notification-status-macos',
  'build:ghostty-terminal-macos'
])
