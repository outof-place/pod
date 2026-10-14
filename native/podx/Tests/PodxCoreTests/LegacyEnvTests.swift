import Darwin
import Testing
@testable import PodxCore

// A terminal from before the decouple has only ORCA_ names (Platform.swift env()). They count
// only in a Pod terminal, whose user data lies in Pod's data folder.
// TODO(pod): drop with that fallback, after 2026-12-31.
let spellings = (legacy: "ORCA_", current: "POD_")  // pod-decouple:keep

/// Runs `body` with these env values (nil unsets), then puts the old ones back.
func withEnv(_ values: [String: String?], _ body: () -> Void) {
  var saved: [String: String?] = [:]
  for (name, value) in values {
    saved[name] = getenv(name).map { String(cString: $0) }
    if let value { setenv(name, value, 1) } else { unsetenv(name) }
  }
  defer {
    for (name, value) in saved {
      if let value { setenv(name, value, 1) } else { unsetenv(name) }
    }
  }
  body()
}

/// A HOME under /tmp (spelled so, while it resolves to /private/tmp) with the apps' data folders.
func makeHome() -> String {
  var template = Array("/tmp/podx-legacy-env-XXXXXX".utf8CString)
  let home = template.withUnsafeMutableBufferPointer { String(cString: mkdtemp($0.baseAddress!)!) }
  var path = home
  for part in ["Library", "Application Support"] {
    path += "/" + part
    mkdir(path, 0o700)
  }
  for folder in homeFolders { mkdir(path + "/" + folder, 0o700) }
  symlink(path + "/orca", path + "/Pod/to-orca")
  return home
}

let homeFolders = ["Pod", "Pod Dev", "Pod2", "orca", "Pod/profile"]

func removeHome(_ home: String) {
  let path = home + "/Library/Application Support"
  unlink(path + "/Pod/to-orca")
  for folder in homeFolders.reversed() { rmdir(path + "/" + folder) }
  for dir in [path, home + "/Library", home] { rmdir(dir) }
}

// One process env, so the cases run one after another.
@Suite(.serialized) final class LegacyEnv {
  let legacy = spellings.legacy + "PODX_LEGACY_ENV_TEST"
  let current = spellings.current + "PODX_LEGACY_ENV_TEST"
  let home = makeHome()

  deinit { removeHome(home) }

  func terminal(userData: String, _ body: () -> Void) {
    withEnv(
      [
        "HOME": home, spellings.legacy + "USER_DATA_PATH": home + "/Library/Application Support/" + userData,
        spellings.current + "USER_DATA_PATH": nil, legacy: nil, current: nil,
      ], body)
  }

  @Test(arguments: ["Pod", "Pod/profile"])
  func readsEitherSpellingOfAnUnsetNameInAPodTerminal(userData: String) {
    terminal(userData: userData) {
      setenv(legacy, "old-terminal", 1)
      #expect(env(current) == "old-terminal")
      #expect(envSet(current))
      #expect(refusedLegacyUserData() == nil)
      setenv(current, "new-terminal", 1)
      #expect(env(current) == "new-terminal")
      #expect(env(legacy) == "old-terminal")
      unsetenv(legacy)
      #expect(env(legacy) == "new-terminal")
      #expect(env("PODX_UNPREFIXED_LEGACY_ENV_TEST") == nil)
    }
  }

  // Orca.app's terminal, a dev Pod's, one whose name only starts with Pod's, and a symlink out of
  // Pod's folder into Orca's.
  @Test(arguments: ["orca", "Pod Dev", "Pod2", "Pod/to-orca"])
  func ignoresTheOrcaSpellingOutsidePodsDataFolder(userData: String) {
    terminal(userData: userData) {
      setenv(legacy, "other-terminal", 1)
      #expect(env(current) == nil)
      #expect(!envSet(current))
      // After the decouple podx refuses to run on it; before, these names are its own.
      let decoupled = USER_DATA_ENV.hasPrefix(spellings.current)
      let named = home + "/Library/Application Support/" + userData
      #expect(refusedLegacyUserData() == (decoupled ? named : nil))
      setenv(current, "explicit", 1)
      #expect(env(current) == "explicit")
    }
  }
}
