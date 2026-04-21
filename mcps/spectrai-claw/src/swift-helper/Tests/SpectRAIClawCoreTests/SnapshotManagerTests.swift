import Foundation
import Testing
@testable import SpectRAIClawCore

// MARK: - Helpers

private func makeElement(
    id: String,
    role: String,
    label: String = "Test",
    identifier: String? = nil
) -> DetectedElement {
    DetectedElement(
        id: id,
        role: role,
        label: label,
        identifier: identifier,
        bounds: Bounds(x: 0, y: 0, width: 100, height: 30),
        isEnabled: true,
        isActionable: false
    )
}

private func makeResult(elements: [DetectedElement] = []) -> ElementDetectionResult {
    ElementDetectionResult(
        snapshotId: nil,
        screenshotPath: "/tmp/test-snapshot.png",
        annotatedPath: nil,
        elements: elements,
        applicationName: "TestApp",
        windowTitle: "Test Window",
        windowBounds: Bounds(x: 100, y: 100, width: 800, height: 600),
        warnings: []
    )
}

// Run tests serially to avoid shared-state races on SnapshotManager.shared
@Suite("SnapshotManager", .serialized)
struct SnapshotManagerTests {

    @Test func roundTrip() {
        let mgr = SnapshotManager.shared
        _ = mgr.cleanSnapshot(nil)
        defer { _ = mgr.cleanSnapshot(nil) }

        let id = mgr.createSnapshot()
        mgr.storeDetectionResult(
            snapshotId: id,
            result: makeResult(elements: [makeElement(id: "e1", role: "AXButton")])
        )

        let retrieved = mgr.getDetectionResult(snapshotId: id)
        #expect(retrieved != nil)
        #expect(retrieved?.snapshotId == id)
        #expect(retrieved?.elements.count == 1)
        #expect(retrieved?.elements.first?.id == "e1")
    }

    @Test func lruEviction() {
        let mgr = SnapshotManager.shared
        _ = mgr.cleanSnapshot(nil)
        let savedTTL = mgr.ttlSeconds
        let savedMax = mgr.maxSnapshots
        defer {
            _ = mgr.cleanSnapshot(nil)
            mgr.ttlSeconds = savedTTL
            mgr.maxSnapshots = savedMax
        }

        mgr.ttlSeconds = 3600
        mgr.maxSnapshots = 25

        var firstId = ""
        for i in 0..<26 {
            let id = mgr.createSnapshot()
            if i == 0 { firstId = id }
            mgr.storeDetectionResult(
                snapshotId: id,
                result: makeResult(elements: [makeElement(id: "e\(i)", role: "AXButton")])
            )
        }

        // 26th insertion must have evicted the first (oldest) snapshot
        #expect(mgr.getDetectionResult(snapshotId: firstId) == nil)
    }

    @Test func ttlExpiry() async throws {
        let mgr = SnapshotManager.shared
        _ = mgr.cleanSnapshot(nil)
        let savedTTL = mgr.ttlSeconds
        defer {
            _ = mgr.cleanSnapshot(nil)
            mgr.ttlSeconds = savedTTL
        }

        mgr.ttlSeconds = 0.1
        let id = mgr.createSnapshot()
        mgr.storeDetectionResult(snapshotId: id, result: makeResult())

        #expect(mgr.getDetectionResult(snapshotId: id) != nil)

        try await Task.sleep(nanoseconds: 200_000_000) // 0.2s > 0.1s TTL

        #expect(mgr.getDetectionResult(snapshotId: id) == nil)
    }

    @Test func findElementsRoleCaseInsensitive() {
        let mgr = SnapshotManager.shared
        _ = mgr.cleanSnapshot(nil)
        defer { _ = mgr.cleanSnapshot(nil) }

        let elements = [
            makeElement(id: "e1", role: "AXButton", label: "OK"),
            makeElement(id: "e2", role: "AXTextField", label: "Name"),
            makeElement(id: "e3", role: "AXLink", label: "Help"),
        ]
        let id = mgr.createSnapshot()
        mgr.storeDetectionResult(snapshotId: id, result: makeResult(elements: elements))

        // Exact case-insensitive match
        let exact = mgr.findElements(snapshotId: id, role: "axbutton", label: nil, identifier: nil)
        #expect(exact.count == 1)
        #expect(exact.first?.id == "e1")

        // Partial role match
        let partial = mgr.findElements(snapshotId: id, role: "field", label: nil, identifier: nil)
        #expect(partial.count == 1)
        #expect(partial.first?.id == "e2")

        // Label match (case-insensitive)
        let byLabel = mgr.findElements(snapshotId: id, role: nil, label: "ok", identifier: nil)
        #expect(byLabel.count == 1)
        #expect(byLabel.first?.id == "e1")
    }
}
