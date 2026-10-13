// Checks an appcast enclosure's EdDSA signature the way an installed app does: Ed25519 over the
// whole archive, against the app's SUPublicEDKey. Independent of Sparkle's tools and of the key's
// source (keychain or stdin), so a wrong key in the outer or a stale signature fails the release.
// Every check also proves it can say no: the same signature over the archive with one byte flipped
// must fail.
//
//   swift product/scripts/sparkle-ed-verify.swift <archive> <base64 edSignature> <base64 SUPublicEDKey>
//   swift product/scripts/sparkle-ed-verify.swift --self-test
import CryptoKit
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("sparkle-ed-verify: \(message)\n".data(using: .utf8)!)
  exit(1)
}

func flipped(_ data: Data) -> Data {
  var copy = data
  copy[copy.startIndex] ^= 0x01
  return copy
}

func valid(_ signature: Data, _ data: Data, _ key: Curve25519.Signing.PublicKey) -> Bool {
  key.isValidSignature(signature, for: data)
}

let args = Array(CommandLine.arguments.dropFirst())
if args == ["--self-test"] {
  let key = Curve25519.Signing.PrivateKey()
  let other = Curve25519.Signing.PrivateKey().publicKey
  let data = Data((0..<4096).map { UInt8(truncatingIfNeeded: $0 &* 31) })
  let signature = try key.signature(for: data)
  guard valid(signature, data, key.publicKey) else { fail("self-test: a good signature failed") }
  guard !valid(signature, flipped(data), key.publicKey) else { fail("self-test: a changed archive passed") }
  guard !valid(signature, data, other) else { fail("self-test: another key passed") }
  guard !valid(signature.prefix(63), data, key.publicKey) else { fail("self-test: a short signature passed") }
  print("sparkle-ed-verify: self-test OK")
  exit(0)
}
guard args.count == 3 else {
  fail("usage: sparkle-ed-verify.swift <archive> <base64 edSignature> <base64 SUPublicEDKey> | --self-test")
}
guard let data = FileManager.default.contents(atPath: args[0]), !data.isEmpty else {
  fail("cannot read \(args[0])")
}
guard let signature = Data(base64Encoded: args[1]), signature.count == 64 else {
  fail("the edSignature is not 64 bytes of base64")
}
guard let raw = Data(base64Encoded: args[2]), raw.count == 32,
  let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw)
else {
  fail("SUPublicEDKey is not a 32-byte Ed25519 public key")
}
guard valid(signature, data, key) else {
  fail("\(args[0]): the edSignature does not verify against SUPublicEDKey: the app would refuse this update")
}
guard !valid(signature, flipped(data), key) else { fail("a changed archive passed: the check proves nothing") }
print("sparkle-ed-verify: \(args[0]) verifies against SUPublicEDKey (\(data.count) bytes)")
