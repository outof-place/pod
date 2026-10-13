import Darwin
import Testing
@testable import PodxCore

// A terminal from before the decouple has only ORCA_ names (Platform.swift env()).
// TODO(pod): drop with that fallback, after 2026-12-31.
let spellings = (legacy: "ORCA_", current: "POD_")  // pod-decouple:keep

@Test func readsEitherSpellingOfAnUnsetName() {
  let suffix = "PODX_LEGACY_ENV_TEST"
  let legacy = spellings.legacy + suffix, current = spellings.current + suffix
  defer {
    unsetenv(legacy)
    unsetenv(current)
  }
  setenv(legacy, "old-terminal", 1)
  #expect(env(current) == "old-terminal")
  #expect(envSet(current))
  setenv(current, "new-terminal", 1)
  #expect(env(current) == "new-terminal")
  #expect(env(legacy) == "old-terminal")
  unsetenv(legacy)
  #expect(env(legacy) == "new-terminal")
  #expect(env("PODX_UNPREFIXED_LEGACY_ENV_TEST") == nil)
}
