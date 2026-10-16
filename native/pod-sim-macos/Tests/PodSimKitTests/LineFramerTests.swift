import Foundation
import Testing
@testable import PodSimKit

@Suite("Line framing")
struct LineFramerTests {
    private func bytes(_ text: String) -> [UInt8] { Array(text.utf8) }

    @Test("a line exactly at the limit is a frame; one byte over is refused and the next line still arrives")
    func limitIsInclusive() {
        var framer = LineFramer(maxFrameBytes: 8)
        let events = framer.push(bytes("12345678\n123456789\n{\"a\":1}\n"))
        #expect(events == [
            .frame(Data("12345678".utf8)),
            .oversized(byteCount: 9),
            .frame(Data("{\"a\":1}".utf8)),
        ])
    }

    @Test("a frame split across reads is joined, and an oversized line is counted across reads without buffering it")
    func splitAcrossReads() {
        var framer = LineFramer(maxFrameBytes: 4)
        #expect(framer.push(bytes("ab")) == [])
        #expect(framer.push(bytes("c\nxyz")) == [.frame(Data("abc".utf8))])
        #expect(framer.push(bytes("zzzz")) == [])
        #expect(framer.bufferedByteCount <= 4)
        #expect(framer.push(bytes("zz\nok\n")) == [.oversized(byteCount: 9), .frame(Data("ok".utf8))])
    }

    @Test("blank lines are skipped, a trailing CR is dropped, and a last line without newline arrives at end of input")
    func blankLinesAndEnd() {
        var framer = LineFramer(maxFrameBytes: 16)
        #expect(framer.push(bytes("\n  \n{}\r\n{\"b\":2}")) == [.frame(Data("{}".utf8))])
        #expect(framer.finish() == [.frame(Data("{\"b\":2}".utf8))])
        #expect(framer.finish() == [])
    }
}
