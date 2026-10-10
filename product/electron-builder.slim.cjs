// Fork-only (Pod): Orca's electron-builder config with the Pod slim profile's packaging cuts.
// product/electron-builder.pod.cjs layers the Pod identity over this instead of the upstream file.
const { applyPodSlimPackaging, preparePodSlimPackaging } = require('./pod-slim-packaging.cjs')

preparePodSlimPackaging()
module.exports = applyPodSlimPackaging(require('../config/electron-builder.config.cjs'))
