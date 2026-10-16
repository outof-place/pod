import Testing
@testable import PodSimKit

@Suite("Main display selection")
struct MainDisplaySelectionTests {
    @Test("display class 0 is the main display even when another framebuffer is larger (idb v1.7.2's rule)")
    func classZeroWins() {
        let candidates = [
            DisplayCandidate(displayClass: 1, width: 1920, height: 1080),
            DisplayCandidate(displayClass: 0, width: 1206, height: 2622),
        ]
        #expect(MainDisplaySelection.pick(candidates, devicePixels: (1206, 2622)) == 1)
    }

    @Test("without display classes, the framebuffer the size of the device's screen wins, then the largest")
    func sizeThenLargest() {
        let noClass = [
            DisplayCandidate(displayClass: nil, width: 640, height: 480),
            DisplayCandidate(displayClass: nil, width: 1206, height: 2622),
            DisplayCandidate(displayClass: nil, width: nil, height: nil),
        ]
        #expect(MainDisplaySelection.pick(noClass, devicePixels: (1206, 2622)) == 1)
        #expect(MainDisplaySelection.pick(noClass, devicePixels: (750, 1334)) == 1)
    }

    @Test("nothing with a class 0 or a surface means no main display")
    func none() {
        let empty = [DisplayCandidate(displayClass: 2, width: nil, height: nil), DisplayCandidate(displayClass: nil, width: nil, height: nil)]
        #expect(MainDisplaySelection.pick(empty, devicePixels: (1206, 2622)) == nil)
        #expect(MainDisplaySelection.pick([], devicePixels: (1206, 2622)) == nil)
    }
}
