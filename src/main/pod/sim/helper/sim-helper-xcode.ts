// Fork-only (Pod): which Xcode pod-sim uses and why, as its self-test reports it (protocol v1).
import { z } from 'zod'

/**
 * The helper takes the first Xcode whose SimulatorKit build has a version-table row: DEVELOPER_DIR,
 * then `xcode-select -p`, then the Xcodes in /Applications and ~/Applications, newest first
 * (`installed`). With none known the first stays (unknown, so nothing private loads).
 */
const XcodeSource = z.enum(['DEVELOPER_DIR', 'xcode-select', 'installed'])

export const SimHelperXcode = z.object({
  developerDir: z.string(),
  source: XcodeSource,
  version: z.string().optional(),
  build: z.string().optional(),
  chosenBecause: z.string().optional(),
  // Every Xcode looked at, in order, when more than one was.
  candidates: z
    .array(
      z.object({
        developerDir: z.string(),
        source: XcodeSource,
        version: z.string().optional(),
        build: z.string().optional(),
        // SimulatorKit's CFBundleVersion, the table's key.
        simulatorKit: z.string().optional(),
        known: z.boolean(),
        // Why it cannot be used at all (no SimulatorKit, the Command Line Tools).
        problem: z.string().optional()
      })
    )
    .optional()
})
