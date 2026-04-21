import Foundation
import Testing
@testable import SpectRAIClawCore

@Suite struct ElementDeduplicationTests {
    private func makeEl(_ id: String, _ role: String, _ label: String, x: Double, y: Double, w: Double, h: Double) -> DetectedElement {
        DetectedElement(id: id, role: role, label: label,
                        bounds: Bounds(x: x, y: y, width: w, height: h),
                        isEnabled: true, isActionable: true)
    }

    @Test func dedupKeepsSmallestRepresentative() {
        let service = ElementDetectionService()
        // Three near-identical AXRadioButton wrapping layers (largest → smallest)
        // big:   (10,10,100,30) area=3000
        // mid:   (10,10,98,29)  area=2842  IoU vs big ≈ 0.947
        // small: (11,10,96,28)  area=2688  IoU vs mid ≈ 0.946
        let big   = makeEl("1", "AXRadioButton", "简洁模式", x: 10, y: 10, w: 100, h: 30)
        let mid   = makeEl("2", "AXRadioButton", "简洁模式", x: 10, y: 10, w:  98, h: 29)
        let small = makeEl("3", "AXRadioButton", "简洁模式", x: 11, y: 10, w:  96, h: 28)
        // Two independent elements — different role or distant bounds
        let btn   = makeEl("4", "AXButton", "确认", x: 200, y: 200, w: 80, h: 30)
        let img   = makeEl("5", "AXImage",  "logo", x:   0, y:   0, w: 50, h: 50)

        let result = service.dedupElements([big, mid, small, btn, img])

        #expect(result.count == 3)
        #expect(result.contains(where: { $0.id == "3" }))   // smallest wins
        #expect(result.contains(where: { $0.id == "4" }))   // btn untouched
        #expect(result.contains(where: { $0.id == "5" }))   // img untouched
        #expect(!result.contains(where: { $0.id == "1" }))  // big removed
        #expect(!result.contains(where: { $0.id == "2" }))  // mid removed
    }

    @Test func dedupDoesNotMergeAcrossRoles() {
        let service = ElementDetectionService()
        // Same bounds, same label, but different roles → both must survive
        let btn = makeEl("a", "AXButton", "ok", x: 0, y: 0, w: 80, h: 30)
        let img = makeEl("b", "AXImage",  "ok", x: 0, y: 0, w: 80, h: 30)

        let result = service.dedupElements([btn, img])
        #expect(result.count == 2)
    }

    @Test func dedupHandlesEmptyLabel() {
        let service = ElementDetectionService()
        // Multiple AXImage "" at same position (wrapper layers)
        let outer = makeEl("x", "AXImage", "", x: 5, y: 5, w: 60, h: 40)
        let inner = makeEl("y", "AXImage", "", x: 6, y: 6, w: 56, h: 36)

        let result = service.dedupElements([outer, inner])
        // inner is smaller → should survive, outer removed
        #expect(result.count == 1)
        #expect(result.first?.id == "y")
    }
}
