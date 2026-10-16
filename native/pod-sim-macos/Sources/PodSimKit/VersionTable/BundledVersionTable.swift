// The version table this binary ships, as data (decoded like an override file, so a fix to a build's
// row needs no release: put the row in POD_SIM_VERSION_TABLE). Keys are CFBundleVersion builds, not
// the version strings: Xcode 26.6 and 27.0 both ship SimulatorKit "16.0" (955.7 and 1005.2).
// Values name an implementation this binary has; a capability left out of a row is unsupported there.
let bundledVersionTableJSON = #"""
{
  "schema": 1,
  "builds": [
    {
      "name": "Xcode 27.0 (27A266a)",
      "coreSimulator": "1171.7",
      "simulatorKit": "1005.2",
      "capabilities": {
        "display": "screenCallbacks",
        "screenshot": "surface"
      },
      "verified": "macOS 27.0.1 (26A434), iOS 26.5 (23F77): stage 0 spike 2026-10-15, stage 2a selftest 2026-10-16"
    }
  ]
}
"""#
