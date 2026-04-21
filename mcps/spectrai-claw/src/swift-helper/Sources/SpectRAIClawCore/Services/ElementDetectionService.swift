import AppKit
import ApplicationServices
import AXorcist
import CoreGraphics
import Foundation

public enum ElementDetectionError: Error, Sendable {
    case axFailure(String)
    case captureFailed(String)
}

public struct ElementDetectionResult: Sendable {
    public let snapshotId: String?
    public let screenshotPath: String
    public let annotatedPath: String?
    public let elements: [DetectedElement]
    public let applicationName: String?
    public let windowTitle: String?
    public let windowBounds: Bounds?
    public let warnings: [String]
}

public final class ElementDetectionService: @unchecked Sendable {
    private struct CacheKey: Hashable {
        let windowId: CGWindowID?
        let pid: pid_t?
        let allowWebFocus: Bool
    }

    private struct CacheEntry {
        let result: [DetectedElement]
        let timestamp: Date
    }

    private var cache: [CacheKey: CacheEntry] = [:]
    private let cacheTTL: TimeInterval = 1.5

    private static let actionableRoles: Set<String> = [
        "AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXComboBox", "AXTextField", "AXTextArea",
        "AXSlider", "AXTab", "AXImage", "AXMenuBarItem", "AXIncrementor",
        "AXSearchField", "AXSwitch",
    ]

    private static let chromiumBundleIds: Set<String> = [
        "com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser",
        "com.electron", "com.microsoft.VSCode", "com.tinyspeck.slackmacgap",
    ]

    public init() {}

    @MainActor
    public func detect(
        windowId: CGWindowID? = nil,
        pid: pid_t? = nil,
        allowWebFocus: Bool = true,
        maxDepth: Int = 8,
        maxCount: Int = 200
    ) async throws -> ElementDetectionResult {
        var warnings: [String] = []

        let targetPid: pid_t
        if let p = pid {
            targetPid = p
        } else if let frontApp = NSWorkspace.shared.frontmostApplication {
            targetPid = frontApp.processIdentifier
        } else {
            throw ElementDetectionError.axFailure("No frontmost application")
        }

        let cacheKey = CacheKey(windowId: windowId, pid: targetPid, allowWebFocus: allowWebFocus)
        if let cached = cache[cacheKey], Date().timeIntervalSince(cached.timestamp) < cacheTTL {
            warnings.append("ax_cache_hit")
            let app = NSRunningApplication(processIdentifier: targetPid)
            let screenshotResult = try await ScreenCaptureService.captureScreen()
            return ElementDetectionResult(
                snapshotId: nil,
                screenshotPath: screenshotResult.path,
                annotatedPath: nil,
                elements: cached.result,
                applicationName: app?.localizedName,
                windowTitle: nil,
                windowBounds: nil,
                warnings: warnings
            )
        }

        let appElement = Element(AXUIElementCreateApplication(targetPid))
        let appName = NSRunningApplication(processIdentifier: targetPid)?.localizedName

        let windowTitle: String?
        let windowBounds: Bounds?

        if let focusedWin = appElement.focusedWindow() {
            windowTitle = focusedWin.title()
            if let frame = focusedWin.frame() {
                windowBounds = Bounds(x: frame.origin.x, y: frame.origin.y, width: frame.width, height: frame.height)
            } else {
                windowBounds = nil
            }
        } else {
            windowTitle = nil
            windowBounds = nil
        }

        var collected: [DetectedElement] = []
        var counter = 0
        walkTree(appElement, depth: 0, maxDepth: maxDepth, maxCount: maxCount, collected: &collected, counter: &counter, parentId: nil)

        if allowWebFocus && shouldAttemptWebFocus(collected, pid: targetPid) {
            for attempt in 0..<2 {
                let webArea = findWebArea(appElement, maxDepth: 4)
                if let wa = webArea {
                    _ = try? wa.performAction(.press)
                    try await Task.sleep(nanoseconds: 150_000_000)
                    collected = []
                    counter = 0
                    walkTree(appElement, depth: 0, maxDepth: maxDepth, maxCount: maxCount, collected: &collected, counter: &counter, parentId: nil)
                    if !shouldAttemptWebFocus(collected, pid: targetPid) { break }
                } else {
                    break
                }
                _ = attempt
            }
        }

        cache[cacheKey] = CacheEntry(result: collected, timestamp: Date())

        let screenshotResult = try await ScreenCaptureService.captureScreen()

        var annotatedPath: String? = nil
        if !collected.isEmpty {
            annotatedPath = try? AnnotatedScreenshot.render(
                sourcePath: screenshotResult.path,
                elements: collected,
                displayBounds: screenshotResult.displayBounds
            )
        }

        return ElementDetectionResult(
            snapshotId: nil,
            screenshotPath: screenshotResult.path,
            annotatedPath: annotatedPath,
            elements: collected,
            applicationName: appName,
            windowTitle: windowTitle,
            windowBounds: windowBounds,
            warnings: warnings
        )
    }

    // MARK: - Private

    @MainActor
    private func walkTree(
        _ element: Element,
        depth: Int,
        maxDepth: Int,
        maxCount: Int,
        collected: inout [DetectedElement],
        counter: inout Int,
        parentId: String?
    ) {
        guard collected.count < maxCount, depth <= maxDepth else { return }

        let role = element.role() ?? ""
        let title = element.title()
        let desc = element.descriptionText()
        let valueRaw = element.value()
        let value: String? = {
            if let s = valueRaw as? String { return s }
            if let n = valueRaw as? NSNumber { return n.stringValue }
            return nil
        }()
        let subrole = element.subrole()
        let identifier = element.identifier()
        let enabled = element.isEnabled() ?? true

        let frame = element.frame()
        let bounds: Bounds
        if let f = frame {
            bounds = Bounds(x: f.origin.x, y: f.origin.y, width: f.width, height: f.height)
        } else {
            bounds = Bounds(x: 0, y: 0, width: 0, height: 0)
        }

        let isTooSmall = bounds.width < 5 && bounds.height < 5
        let isActionable = Self.actionableRoles.contains(role)
        let hasContent = (title != nil && !title!.isEmpty) || (desc != nil && !desc!.isEmpty) || (value != nil && !value!.isEmpty)

        if !isTooSmall && (isActionable || hasContent) {
            counter += 1
            let elemId = "elem_\(counter)"
            let label = title ?? desc ?? value ?? ""
            collected.append(DetectedElement(
                id: elemId,
                role: role,
                subrole: subrole,
                label: label,
                title: title,
                value: value,
                description: desc,
                identifier: identifier,
                keyboardShortcut: nil,
                bounds: bounds,
                isEnabled: enabled,
                isActionable: isActionable,
                parentId: parentId
            ))

            if depth < maxDepth {
                if let children = element.children() {
                    for child in children {
                        guard collected.count < maxCount else { break }
                        walkTree(child, depth: depth + 1, maxDepth: maxDepth, maxCount: maxCount, collected: &collected, counter: &counter, parentId: elemId)
                    }
                }
            }
        } else {
            if depth < maxDepth {
                if let children = element.children() {
                    for child in children {
                        guard collected.count < maxCount else { break }
                        walkTree(child, depth: depth + 1, maxDepth: maxDepth, maxCount: maxCount, collected: &collected, counter: &counter, parentId: parentId)
                    }
                }
            }
        }
    }

    @MainActor
    private func shouldAttemptWebFocus(_ elements: [DetectedElement], pid: pid_t) -> Bool {
        let hasTextField = elements.contains { $0.role == "AXTextField" || $0.role == "AXTextArea" }
        if hasTextField { return false }
        guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
        if let bundleId = app.bundleIdentifier, Self.chromiumBundleIds.contains(bundleId) {
            return true
        }
        return false
    }

    @MainActor
    private func findWebArea(_ element: Element, maxDepth: Int, depth: Int = 0) -> Element? {
        guard depth <= maxDepth else { return nil }
        let role = element.role() ?? ""
        if role == "AXWebArea" { return element }
        let roleDesc = element.roleDescription() ?? ""
        if roleDesc.lowercased().contains("web area") { return element }
        if let children = element.children() {
            for child in children {
                if let found = findWebArea(child, maxDepth: maxDepth, depth: depth + 1) {
                    return found
                }
            }
        }
        return nil
    }
}
