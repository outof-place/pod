// Test-only NODE_OPTIONS preload: turns a probe Electron into a Dock-less UIElement app on macOS.
if (process.versions.electron && process.type === 'browser' && process.platform === 'darwin') {
  // Why: Electron's module is not registered yet while NODE_OPTIONS preloads run.
  setImmediate(() => require('electron').app.dock?.hide())
}
