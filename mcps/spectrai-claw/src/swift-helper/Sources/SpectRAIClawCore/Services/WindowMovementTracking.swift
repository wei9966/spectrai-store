import Foundation
import CoreGraphics
import ApplicationServices

// On-demand window bounds lookup — no AXObserver subscription.
//
// Each currentState() call reads directly from CGWindowListCopyWindowInfo (~5-10ms overhead).
// This is simpler and more reliable in a daemon context where AXObserver requires a dedicated
// thread with an active CFRunLoop.
//
// TODO: For sub-millisecond tracking, replace with AXObserver on kAXMovedNotification,
//       kAXResizedNotification, and kAXUIElementDestroyedNotification. Observers must be
//       scheduled on a thread running CFRunLoopRun(). Create a dedicated GCD thread:
//         let t = Thread { CFRunLoopRun() }; t.start()
//       then schedule the observer from that thread's RunLoop via CFRunLoopAddSource.

public final class WindowMovementTracking: @unchecked Sendable {
    public static let shared = WindowMovementTracking()
    private init() {}

    public struct WindowState: Sendable {
        public let windowId: CGWindowID
        public let pid: pid_t
        public let bounds: CGRect
        public let lastUpdated: TimeInterval
        public let exists: Bool
    }

    // Reference counts for tracked windows (kept for API compatibility; no observer in this impl).
    private var refCounts: [CGWindowID: Int] = [:]
    private let lock = NSLock()

    public func track(pid: pid_t, windowId: CGWindowID) {
        lock.lock()
        defer { lock.unlock() }
        refCounts[windowId, default: 0] += 1
    }

    public func untrack(pid: pid_t, windowId: CGWindowID) {
        lock.lock()
        defer { lock.unlock() }
        guard let count = refCounts[windowId] else { return }
        if count <= 1 {
            refCounts.removeValue(forKey: windowId)
        } else {
            refCounts[windowId] = count - 1
        }
    }

    /// Returns live window state by windowId (direct CGWindowListCopyWindowInfo read).
    public func currentState(windowId: CGWindowID) -> WindowState {
        let notFound = WindowState(windowId: windowId, pid: 0, bounds: .zero,
                                   lastUpdated: Date().timeIntervalSince1970, exists: false)
        guard windowId != 0 else { return notFound }

        guard let list = CGWindowListCopyWindowInfo(
            CGWindowListOption(rawValue: 0), kCGNullWindowID
        ) as? [[String: Any]] else { return notFound }

        for info in list {
            guard let widNum = info[kCGWindowNumber as String] as? NSNumber,
                  CGWindowID(widNum.uint32Value) == windowId else { continue }
            let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
            let bounds = extractBounds(from: info)
            return WindowState(windowId: windowId, pid: pid_t(pid), bounds: bounds,
                               lastUpdated: Date().timeIntervalSince1970, exists: true)
        }
        return notFound
    }

    /// Find a window whose bounds approximately match the target (fallback when windowId is unknown).
    func currentState(matchingBounds target: CGRect, tolerance: CGFloat = 2) -> WindowState? {
        guard let list = CGWindowListCopyWindowInfo(
            CGWindowListOption(rawValue: 0), kCGNullWindowID
        ) as? [[String: Any]] else { return nil }

        for info in list {
            guard let widNum = info[kCGWindowNumber as String] as? NSNumber else { continue }
            let bounds = extractBounds(from: info)
            guard abs(bounds.origin.x - target.origin.x) <= tolerance,
                  abs(bounds.origin.y - target.origin.y) <= tolerance,
                  abs(bounds.size.width - target.size.width) <= tolerance,
                  abs(bounds.size.height - target.size.height) <= tolerance else { continue }
            let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
            let wid = CGWindowID(widNum.uint32Value)
            return WindowState(windowId: wid, pid: pid_t(pid), bounds: bounds,
                               lastUpdated: Date().timeIntervalSince1970, exists: true)
        }
        return nil
    }

    public var trackedWindowCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return refCounts.count
    }

    // MARK: - Private

    private func extractBounds(from info: [String: Any]) -> CGRect {
        guard let boundsRef = info[kCGWindowBounds as String] as? NSDictionary else { return .zero }
        var rect = CGRect.zero
        CGRectMakeWithDictionaryRepresentation(boundsRef as CFDictionary, &rect)
        return rect
    }
}
