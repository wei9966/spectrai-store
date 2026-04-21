import AppKit
import ApplicationServices
import AXorcist
import CoreGraphics
import Foundation

public enum WindowServiceError: Error, Sendable {
    case notFound(String)
    case actionFailed(String)
}

public enum WindowService {
    @MainActor
    public static func list(pid: pid_t? = nil) -> [WindowInfo] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }

        var results: [WindowInfo] = []

        for info in windowList {
            guard let wid = info[kCGWindowNumber as String] as? Int,
                  let ownerPid = info[kCGWindowOwnerPID as String] as? Int32 else {
                continue
            }

            if let filterPid = pid, ownerPid != filterPid {
                continue
            }

            guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else {
                continue
            }

            let title = info[kCGWindowName as String] as? String ?? ""
            let boundsDict = info[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
            let bounds = Bounds(
                x: Double(boundsDict["X"] ?? 0),
                y: Double(boundsDict["Y"] ?? 0),
                width: Double(boundsDict["Width"] ?? 0),
                height: Double(boundsDict["Height"] ?? 0)
            )

            let isOnScreen = info[kCGWindowIsOnscreen as String] as? Bool ?? true
            let frontApp = NSWorkspace.shared.frontmostApplication
            let isFrontmost = (frontApp?.processIdentifier == ownerPid)

            results.append(WindowInfo(
                windowId: wid,
                pid: ownerPid,
                title: title,
                bounds: bounds,
                isMinimized: !isOnScreen,
                isFrontmost: isFrontmost
            ))
        }

        return results
    }

    @MainActor
    public static func focus(windowId: CGWindowID) async throws {
        guard let windowList = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw WindowServiceError.notFound("Cannot list windows")
        }

        guard let windowInfo = windowList.first(where: { ($0[kCGWindowNumber as String] as? Int) == Int(windowId) }),
              let ownerPid = windowInfo[kCGWindowOwnerPID as String] as? Int32 else {
            throw WindowServiceError.notFound("Window \(windowId) not found")
        }

        guard let app = NSRunningApplication(processIdentifier: ownerPid) else {
            throw WindowServiceError.notFound("Application for window \(windowId) not found")
        }

        app.activate()
        try await Task.sleep(nanoseconds: 100_000_000)

        let appElement = Element(AXUIElementCreateApplication(ownerPid))
        if let windows: [AXUIElement] = appElement.attribute(.windows) {
            for winUI in windows {
                let winElement = Element(winUI)
                var windowIdRef: CFTypeRef?
                let err = AXUIElementCopyAttributeValue(winUI, "_AXWindowID" as CFString, &windowIdRef)
                if err == .success, let wid = windowIdRef as? NSNumber, wid.uint32Value == windowId {
                    _ = try? winElement.performAction(.raise)
                    return
                }
            }
        }

        if let mainWin = appElement.focusedWindow() {
            _ = try? mainWin.performAction(.raise)
        }
    }

    @MainActor
    public static func close(windowId: CGWindowID) async throws {
        guard let windowList = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw WindowServiceError.notFound("Cannot list windows")
        }

        guard let windowInfo = windowList.first(where: { ($0[kCGWindowNumber as String] as? Int) == Int(windowId) }),
              let ownerPid = windowInfo[kCGWindowOwnerPID as String] as? Int32 else {
            throw WindowServiceError.notFound("Window \(windowId) not found")
        }

        let appElement = Element(AXUIElementCreateApplication(ownerPid))
        if let windows: [AXUIElement] = appElement.attribute(.windows) {
            for winUI in windows {
                var windowIdRef: CFTypeRef?
                let err = AXUIElementCopyAttributeValue(winUI, "_AXWindowID" as CFString, &windowIdRef)
                if err == .success, let wid = windowIdRef as? NSNumber, wid.uint32Value == windowId {
                    let winElement = Element(winUI)
                    if let closeBtn: AXUIElement = winElement.attribute(.closeButton) {
                        let btnElement = Element(closeBtn)
                        try btnElement.performAction(.press)
                        return
                    }
                }
            }
        }

        throw WindowServiceError.actionFailed("Could not find close button for window \(windowId)")
    }
}
