import Testing
@testable import PodxCore

@Test func reindentKeepsWireSpelling() throws {
  let wire = Array(#"{"a":[1,2.5e-7,{}],"b":"é\ud800x","c":[],"d":null}"#.utf8)
  let value = try parseJSON(wire)
  let expected = "{\n  \"a\": [\n    1,\n    2.5e-7,\n    {}\n  ],\n  \"b\": \"é\\ud800x\",\n  \"c\": [],\n  \"d\": null\n}"
  #expect(String(decoding: value.stringify(), as: UTF8.self) == expected)
}

@Test func decodesLoneSurrogateAsReplacement() throws {
  let value = try parseJSON(Array(#""a😀b\ud800""#.utf8))
  #expect(value.stringValue?.utf8 == Array("a😀b\u{FFFD}".utf8))
}
