// Fork-only (Pod): the feature profile global-setup compiled the app with (src/shared/product/features.ts).
// Why the env: global-setup builds in this same process env; a SKIP_BUILD run must reuse a matching out/.
import { readPodBuildProfile } from '../../../config/build-plugins/pod-build-profile'
import { podFeatureFlags } from '../../../src/shared/product/features'

export const e2ePodFeatures = podFeatureFlags(readPodBuildProfile(process.env))
