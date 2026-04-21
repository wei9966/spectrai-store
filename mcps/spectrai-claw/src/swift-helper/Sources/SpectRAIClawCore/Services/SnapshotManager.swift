import Foundation
import CoreGraphics

// Usage in Dispatcher.swift (T9 接入示例):
//   case "detectElements":
//     let result = try await detectionService.detect(
//         windowId: params.windowId.map { CGWindowID($0) },
//         pid: params.pid.map { pid_t($0) }
//     )
//     let snapshotId = SnapshotManager.shared.createSnapshot()
//     SnapshotManager.shared.storeDetectionResult(
//         snapshotId: snapshotId,
//         result: result,
//         windowId: params.windowId.map { CGWindowID($0) }
//     )
//     return encodeResult(result.with(snapshotId: snapshotId))

private struct SnapshotEntry {
    var result: ElementDetectionResult
    let createdAt: TimeInterval
    var lastAccessedAt: TimeInterval
    let windowId: CGWindowID?
}

/// In-memory LRU snapshot store. Thread-safe via NSLock.
public final class SnapshotManager: @unchecked Sendable {
    public static let shared = SnapshotManager()
    private init() {}

    public var ttlSeconds: TimeInterval = 600
    public var maxSnapshots: Int = 25

    private var entries: [String: SnapshotEntry] = [:]
    private var lruOrder: [String] = []
    private let lock = NSLock()

    /// Returns a new snapshotId in format "epochMs-rand4hex". The slot is empty until storeDetectionResult is called.
    public func createSnapshot() -> String {
        let epochMs = Int64(Date().timeIntervalSince1970 * 1000)
        let rand = UInt16.random(in: 0..<0xFFFF)
        return String(format: "%lld-%04x", epochMs, rand)
    }

    /// Store detection result. windowId enables adjustPoint window-tracking; pass nil if unknown.
    public func storeDetectionResult(snapshotId: String, result: ElementDetectionResult, windowId: CGWindowID? = nil) {
        lock.lock()
        defer { lock.unlock() }

        let now = Date().timeIntervalSince1970

        if entries[snapshotId] == nil && entries.count >= maxSnapshots {
            evictLRU()
        }

        entries[snapshotId] = SnapshotEntry(
            result: result,
            createdAt: now,
            lastAccessedAt: now,
            windowId: windowId
        )
        lruOrder.removeAll { $0 == snapshotId }
        lruOrder.append(snapshotId)
    }

    /// Retrieve snapshot result with snapshotId populated. Refreshes lastAccessedAt on hit.
    /// Returns nil if not found or TTL expired.
    public func getDetectionResult(snapshotId: String) -> ElementDetectionResult? {
        lock.lock()
        defer { lock.unlock() }

        guard var entry = entries[snapshotId] else { return nil }

        let now = Date().timeIntervalSince1970
        if entry.lastAccessedAt + ttlSeconds < now {
            entries.removeValue(forKey: snapshotId)
            lruOrder.removeAll { $0 == snapshotId }
            return nil
        }

        entry.lastAccessedAt = now
        entries[snapshotId] = entry
        lruOrder.removeAll { $0 == snapshotId }
        lruOrder.append(snapshotId)

        return entry.result.with(snapshotId: snapshotId)
    }

    public func getElement(snapshotId: String, elementId: String) -> DetectedElement? {
        guard let result = getDetectionResult(snapshotId: snapshotId) else { return nil }
        return result.elements.first { $0.id == elementId }
    }

    /// Filter elements by role/label/identifier (case-insensitive contains on each non-nil criterion).
    public func findElements(snapshotId: String, role: String?, label: String?, identifier: String?) -> [DetectedElement] {
        guard let result = getDetectionResult(snapshotId: snapshotId) else { return [] }
        return result.elements.filter { elem in
            if let r = role, !elem.role.lowercased().contains(r.lowercased()) { return false }
            if let l = label, !elem.label.lowercased().contains(l.lowercased()) { return false }
            if let i = identifier {
                guard let eid = elem.identifier else { return false }
                if !eid.lowercased().contains(i.lowercased()) { return false }
            }
            return true
        }
    }

    /// List non-expired snapshots sorted by createdAt descending.
    public func listSnapshots() -> [SnapshotInfo] {
        lock.lock()
        defer { lock.unlock() }

        let now = Date().timeIntervalSince1970
        return entries
            .filter { $0.value.lastAccessedAt + ttlSeconds >= now }
            .map { (id, entry) in
                SnapshotInfo(
                    id: id,
                    createdAt: Int64(entry.createdAt * 1000),
                    windowTitle: entry.result.windowTitle
                )
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    /// Remove a specific snapshot (pass nil to clear all). Returns number removed.
    @discardableResult
    public func cleanSnapshot(_ snapshotId: String?) -> Int {
        lock.lock()
        defer { lock.unlock() }

        if let id = snapshotId {
            guard entries.removeValue(forKey: id) != nil else { return 0 }
            lruOrder.removeAll { $0 == id }
            return 1
        } else {
            let count = entries.count
            entries.removeAll()
            lruOrder.removeAll()
            return count
        }
    }

    public enum AdjustResult: Sendable {
        case unchanged
        case adjusted(CGPoint)
        case stale
        case noSnapshot
    }

    /// Check if the window moved since the snapshot was taken and compute the adjusted coordinate.
    /// Returns .stale if the window was resized or is gone, .noSnapshot if no bounds were recorded.
    public func adjustPoint(_ point: CGPoint, snapshotId: String) -> AdjustResult {
        lock.lock()
        guard let entry = entries[snapshotId] else {
            lock.unlock()
            return .noSnapshot
        }
        let storedBounds = entry.result.windowBounds
        let storedWindowId = entry.windowId
        lock.unlock()

        guard let stored = storedBounds else { return .noSnapshot }

        let storedRect = CGRect(x: stored.x, y: stored.y, width: stored.width, height: stored.height)

        let ws: WindowMovementTracking.WindowState
        if let wid = storedWindowId, wid != 0 {
            ws = WindowMovementTracking.shared.currentState(windowId: wid)
        } else if let found = WindowMovementTracking.shared.currentState(matchingBounds: storedRect) {
            ws = found
        } else {
            return .stale
        }

        guard ws.exists else { return .stale }

        let dx = ws.bounds.origin.x - storedRect.origin.x
        let dy = ws.bounds.origin.y - storedRect.origin.y
        let dw = ws.bounds.size.width - storedRect.size.width
        let dh = ws.bounds.size.height - storedRect.size.height

        // Resize makes element coordinates unreliable
        if abs(dw) > 0.5 || abs(dh) > 0.5 { return .stale }
        if abs(dx) < 0.5 && abs(dy) < 0.5 { return .unchanged }

        return .adjusted(CGPoint(x: point.x + dx, y: point.y + dy))
    }

    // MARK: - Private

    private func evictLRU() {
        guard let oldest = lruOrder.first else { return }
        entries.removeValue(forKey: oldest)
        lruOrder.removeFirst()
    }
}

// MARK: - ElementDetectionResult convenience

extension ElementDetectionResult {
    public func with(snapshotId: String) -> ElementDetectionResult {
        return ElementDetectionResult(
            snapshotId: snapshotId,
            screenshotPath: screenshotPath,
            annotatedPath: annotatedPath,
            elements: elements,
            applicationName: applicationName,
            windowTitle: windowTitle,
            windowBounds: windowBounds,
            warnings: warnings
        )
    }
}
