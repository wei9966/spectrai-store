import AppKit
import ApplicationServices
import AXorcist
import CoreGraphics
import Foundation

public enum ElementDetectionError: Error, Sendable {
    case axFailure(String)
    case captureFailed(String)
}

public enum DetectionMode: String, Codable, Sendable, Hashable {
    case auto
    case ax_only
    case ax_plus_vision
    case ax_plus_cdp
    case cdp_only
    case vision_only
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
        let mode: DetectionMode
        let captureMaxWidth: Int?
    }

    private struct CacheEntry {
        let result: [DetectedElement]
        let timestamp: Date
    }

    private var cache: [CacheKey: CacheEntry] = [:]
    private let cacheTTL: TimeInterval = 1.5
    private let autoVisionSkipThreshold = 50

    // Extended role set: added web/container roles alongside standard actionable roles.
    private static let actionableRoles: Set<String> = [
        "AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXComboBox", "AXTextField", "AXTextArea",
        "AXSlider", "AXTab", "AXImage", "AXMenuBarItem", "AXIncrementor",
        "AXSearchField", "AXSwitch",
        // Web/container roles for Chromium SPA and WKWebView pages
        "AXStaticText", "AXGroup", "AXGenericElement",
        "AXOutline", "AXList", "AXListItem",
        "AXDisclosureTriangle", "AXTabGroup", "AXSplitter",
    ]

    // These roles produce too many empty wrapper nodes unless they carry a label.
    private static let requiresLabelRoles: Set<String> = [
        "AXGroup", "AXGenericElement",
    ]

    private static let chromiumBundleIds: Set<String> = [
        "com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser",
        "com.electron", "com.microsoft.VSCode", "com.tinyspeck.slackmacgap",
    ]

    private static let cdpCapableBundleIds: Set<String> = [
        "com.google.Chrome",
        "com.microsoft.edgemac",
        "com.brave.Browser",
        "com.vivaldi.Vivaldi",
        "com.operasoftware.Opera",
    ]

    public init() {}

    @MainActor
    public func detect(
        windowId: CGWindowID? = nil,
        pid: pid_t? = nil,
        allowWebFocus: Bool = true,
        maxDepth: Int = 12,
        maxCount: Int = 500,
        mode: DetectionMode = .auto,
        captureMaxWidth: Int? = nil
    ) async throws -> ElementDetectionResult {
        var warnings: [String] = []
        if WarmupService.shared.isPending {
            warnings.append("warmup_pending")
        }
        let effectiveCaptureMaxWidth = captureMaxWidth ?? 1280

        let targetPid: pid_t
        if let p = pid {
            targetPid = p
        } else if let frontApp = NSWorkspace.shared.frontmostApplication {
            targetPid = frontApp.processIdentifier
        } else {
            throw ElementDetectionError.axFailure("No frontmost application")
        }

        let cacheKey = CacheKey(
            windowId: windowId,
            pid: targetPid,
            allowWebFocus: allowWebFocus,
            mode: mode,
            captureMaxWidth: captureMaxWidth
        )
        if let cached = cache[cacheKey], Date().timeIntervalSince(cached.timestamp) < cacheTTL {
            warnings.append("ax_cache_hit")
            let app = NSRunningApplication(processIdentifier: targetPid)
            let screenshotResult = try await ScreenCaptureService.captureScreen(maxWidth: effectiveCaptureMaxWidth)
            Self.appendScreenshotResizedWarningIfNeeded(
                screenshotResult,
                requestedMaxWidth: captureMaxWidth,
                warnings: &warnings
            )
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

        let rawAppElement = AXUIElementCreateApplication(targetPid)
        AXUIElementSetMessagingTimeout(rawAppElement, 3.0)
        warnings.append("ax_timeout_set_3s")
        let appElement = Element(rawAppElement)
        let appName = NSRunningApplication(processIdentifier: targetPid)?.localizedName
        let bundleId = NSRunningApplication(processIdentifier: targetPid)?.bundleIdentifier ?? ""

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

        let screenshotResult = try await ScreenCaptureService.captureScreen(maxWidth: effectiveCaptureMaxWidth)
        Self.appendScreenshotResizedWarningIfNeeded(
            screenshotResult,
            requestedMaxWidth: captureMaxWidth,
            warnings: &warnings
        )

        // S10: keep CDP parallel path, but switch ax_plus_vision to serial AX -> masked Vision.
        let cdpParallelHandle: Task<[DetectedElement], Never>?

        if mode == .ax_plus_cdp {
            let pid = targetPid
            let mc = maxCount
            let wb = windowBounds
            cdpParallelHandle = Task.detached {
                let port = await BrowserControlService.detectDebugPort(pid: pid)
                guard port > 0 else { return [] }
                guard let tabs = try? await BrowserControlService.listTabs(port: port),
                      let tab = tabs.first else { return [] }
                let origin = wb.map { CGPoint(x: $0.x, y: $0.y) } ?? .zero
                let elements = try? await BrowserControlService.detectElements(
                    webSocketUrl: tab.webSocketUrl,
                    windowOrigin: origin,
                    maxElements: mc
                )
                return elements?.map { $0.toDetected() } ?? []
            }
            warnings.append("parallel_detection")
        } else {
            cdpParallelHandle = nil
            if mode == .ax_plus_vision {
                warnings.append("serial_ax_then_masked_vision")
            }
        }

        // Phase 1: AX detection (skip for cdp_only / vision_only)
        var collected: [DetectedElement] = []
        let needsAX = mode != .cdp_only && mode != .vision_only
        if needsAX {
            var counter = 0
            walkTree(appElement, depth: 0, maxDepth: maxDepth, maxCount: maxCount, parentFrame: nil, collected: &collected, counter: &counter, parentId: nil)

            if allowWebFocus {
                await wakeUpWebContent(
                    appElement: appElement,
                    pid: targetPid,
                    maxDepth: maxDepth,
                    maxCount: maxCount,
                    collected: &collected,
                    counter: &counter,
                    warnings: &warnings
                )
            }

            let beforeDedup = collected.count
            collected = dedupElements(collected)
            let afterDedup = collected.count
            if beforeDedup > 0 && Double(beforeDedup - afterDedup) / Double(beforeDedup) > 0.3 {
                warnings.append("deduped_\(beforeDedup)->_\(afterDedup)")
            }
        }

        // Phase 2: Supplementary detection based on mode
        let isCdpCapable = Self.cdpCapableBundleIds.contains(bundleId)

        switch mode {
        case .auto:
            let actionableCount = collected.filter(\.isActionable).count
            let axElementCount = collected.count
            if actionableCount < 15 {
                var supplemented = false
                if isCdpCapable {
                    if let extras = await supplementWithCDP(
                        pid: targetPid, existing: collected, maxCount: maxCount,
                        windowBounds: windowBounds, warnings: &warnings
                    ) {
                        collected.append(contentsOf: extras)
                        supplemented = true
                    }
                }
                if !supplemented {
                    if axElementCount >= autoVisionSkipThreshold {
                        warnings.append("auto_skipped_vision_ax_count_\(axElementCount)")
                    } else if let extras = await supplementWithVision(
                        screenshotPath: screenshotResult.path,
                        displayBounds: screenshotResult.displayBounds,
                        existing: collected, maxCount: maxCount, warnings: &warnings
                    ) {
                        collected.append(contentsOf: extras)
                    }
                }
            }

        case .ax_only:
            break

        case .ax_plus_vision:
            let remaining = maxCount - collected.count
            guard remaining > 0 else { break }

            let axRects = collected.map {
                CGRect(x: $0.bounds.x, y: $0.bounds.y, width: $0.bounds.width, height: $0.bounds.height)
            }
            let excludeRegions = axRects.count >= 10 ? axRects : []
            warnings.append("vision_with_ax_mask_\(excludeRegions.count)")

            do {
                let visionElements = try await VisionFallbackService.detect(
                    imagePath: screenshotResult.path,
                    captureOrigin: screenshotResult.displayBounds.origin,
                    captureSize: screenshotResult.displayBounds.size,
                    existingBounds: axRects,
                    maxElements: remaining,
                    excludeRegions: excludeRegions
                )
                let filtered = visionElements.filter { v in
                    !collected.contains { ax in Self.iou(v.bounds, ax.bounds) >= 0.5 }
                }
                warnings.append("vision_supplemented_\(filtered.count)")
                collected.append(contentsOf: filtered.map { $0.toDetected() })
            } catch {
                warnings.append("vision_failed_\(error.localizedDescription)")
            }

        case .ax_plus_cdp:
            // Await concurrent CDP task (started before AX scan), merge with IoU dedup
            if let handle = cdpParallelHandle {
                let cdpElements = await handle.value
                let filtered = cdpElements.filter { el in
                    !collected.contains { ax in Self.iou(el.bounds, ax.bounds) >= 0.5 }
                }
                warnings.append("cdp_supplemented_\(filtered.count)")
                collected.append(contentsOf: filtered)
            }

        case .cdp_only:
            if let extras = await cdpOnlyDetect(
                pid: targetPid, maxCount: maxCount,
                windowBounds: windowBounds, warnings: &warnings
            ) {
                collected = extras
            }

        case .vision_only:
            if let extras = await visionOnlyDetect(
                screenshotPath: screenshotResult.path,
                displayBounds: screenshotResult.displayBounds,
                maxCount: maxCount, warnings: &warnings
            ) {
                collected = extras
            }
        }

        if collected.count > maxCount {
            collected = Array(collected.prefix(maxCount))
        }

        cache[cacheKey] = CacheEntry(result: collected, timestamp: Date())

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

    // MARK: - Supplementary Detection

    @MainActor
    private func supplementWithVision(
        screenshotPath: String,
        displayBounds: CGRect,
        existing: [DetectedElement],
        maxCount: Int,
        warnings: inout [String]
    ) async -> [DetectedElement]? {
        let remaining = maxCount - existing.count
        guard remaining > 0 else { return nil }
        let existingRects = existing.map {
            CGRect(x: $0.bounds.x, y: $0.bounds.y, width: $0.bounds.width, height: $0.bounds.height)
        }
        do {
            let visionElements = try await VisionFallbackService.detect(
                imagePath: screenshotPath,
                captureOrigin: displayBounds.origin,
                captureSize: displayBounds.size,
                existingBounds: existingRects,
                maxElements: remaining
            )
            warnings.append("vision_supplemented_\(visionElements.count)")
            return visionElements.map { $0.toDetected() }
        } catch {
            warnings.append("vision_failed_\(error.localizedDescription)")
            return nil
        }
    }

    @MainActor
    private func supplementWithCDP(
        pid: pid_t,
        existing: [DetectedElement],
        maxCount: Int,
        windowBounds: Bounds?,
        warnings: inout [String]
    ) async -> [DetectedElement]? {
        let port = await BrowserControlService.detectDebugPort(pid: pid)
        guard port > 0 else {
            warnings.append("cdp_no_debug_port")
            return nil
        }
        do {
            let tabs = try await BrowserControlService.listTabs(port: port)
            guard let tab = tabs.first else {
                warnings.append("cdp_no_tabs")
                return nil
            }
            // Window bounds top-left approximates CDP coordinate origin
            let origin = windowBounds.map { CGPoint(x: $0.x, y: $0.y) } ?? .zero
            let remaining = maxCount - existing.count
            let cdpElements = try await BrowserControlService.detectElements(
                webSocketUrl: tab.webSocketUrl,
                windowOrigin: origin,
                maxElements: remaining
            )
            let existingRects = existing.map {
                CGRect(x: $0.bounds.x, y: $0.bounds.y, width: $0.bounds.width, height: $0.bounds.height)
            }
            let filtered = cdpElements.filter { el in
                !existingRects.contains { Self.iou(el.bounds, $0) >= 0.5 }
            }
            warnings.append("cdp_supplemented_\(filtered.count)")
            return filtered.map { $0.toDetected() }
        } catch {
            warnings.append("cdp_failed_\(error.localizedDescription)")
            return nil
        }
    }

    @MainActor
    private func cdpOnlyDetect(
        pid: pid_t,
        maxCount: Int,
        windowBounds: Bounds?,
        warnings: inout [String]
    ) async -> [DetectedElement]? {
        let port = await BrowserControlService.detectDebugPort(pid: pid)
        guard port > 0 else {
            warnings.append("cdp_no_debug_port")
            return nil
        }
        do {
            let tabs = try await BrowserControlService.listTabs(port: port)
            guard let tab = tabs.first else {
                warnings.append("cdp_no_tabs")
                return nil
            }
            let origin = windowBounds.map { CGPoint(x: $0.x, y: $0.y) } ?? .zero
            let cdpElements = try await BrowserControlService.detectElements(
                webSocketUrl: tab.webSocketUrl,
                windowOrigin: origin,
                maxElements: maxCount
            )
            warnings.append("cdp_detected_\(cdpElements.count)")
            return cdpElements.map { $0.toDetected() }
        } catch {
            warnings.append("cdp_failed_\(error.localizedDescription)")
            return nil
        }
    }

    @MainActor
    private func visionOnlyDetect(
        screenshotPath: String,
        displayBounds: CGRect,
        maxCount: Int,
        warnings: inout [String]
    ) async -> [DetectedElement]? {
        do {
            let visionElements = try await VisionFallbackService.detect(
                imagePath: screenshotPath,
                captureOrigin: displayBounds.origin,
                captureSize: displayBounds.size,
                maxElements: maxCount
            )
            warnings.append("vision_detected_\(visionElements.count)")
            return visionElements.map { $0.toDetected() }
        } catch {
            warnings.append("vision_failed_\(error.localizedDescription)")
            return nil
        }
    }

    private static func appendScreenshotResizedWarningIfNeeded(
        _ screenshot: ScreenCaptureService.CaptureResult,
        requestedMaxWidth: Int?,
        warnings: inout [String]
    ) {
        guard requestedMaxWidth == nil else { return }
        let nativeWidth = Int(round(screenshot.displayBounds.width * 2))
        if screenshot.width < nativeWidth {
            warnings.append("screenshot_resized_1280")
        }
    }

    private static func iou(_ a: CGRect, _ b: CGRect) -> Double {
        let intersection = a.intersection(b)
        if intersection.isNull || intersection.isEmpty { return 0 }
        let interArea = Double(intersection.width * intersection.height)
        let unionArea = Double(a.width * a.height) + Double(b.width * b.height) - interArea
        return unionArea > 0 ? interArea / unionArea : 0
    }

    private static func iou(_ a: Bounds, _ b: Bounds) -> Double {
        let ix1 = max(a.x, b.x), iy1 = max(a.y, b.y)
        let ix2 = min(a.x + a.width, b.x + b.width), iy2 = min(a.y + a.height, b.y + b.height)
        guard ix2 > ix1 && iy2 > iy1 else { return 0 }
        let interArea = (ix2 - ix1) * (iy2 - iy1)
        let unionArea = a.width * a.height + b.width * b.height - interArea
        return unionArea > 0 ? interArea / unionArea : 0
    }

    // MARK: - Deduplication

    func dedupElements(_ elements: [DetectedElement]) -> [DetectedElement] {
        var result: [DetectedElement] = []
        for element in elements {
            var shouldKeep = true
            for (idx, kept) in result.enumerated() {
                if element.role == kept.role && element.label == kept.label && Self.iou(element.bounds, kept.bounds) > 0.9 {
                    let elArea = element.bounds.width * element.bounds.height
                    let keptArea = kept.bounds.width * kept.bounds.height
                    if elArea < keptArea {
                        result[idx] = element
                    }
                    shouldKeep = false
                    break
                }
            }
            if shouldKeep { result.append(element) }
        }
        return result
    }

    // MARK: - Private

    /// Forces Chromium-family browsers and Electron/Tauri apps to sync their full AX tree.
    ///
    /// AXManualAccessibility + AXEnhancedUserInterface are undocumented but widely-used
    /// hints that tell Blink/WebKit to stop lazy-loading the accessibility tree. Without
    /// them, describe_screen returns only the initially-visible AX nodes (~8–41 elements).
    @MainActor
    private func wakeUpWebContent(
        appElement: Element,
        pid: pid_t,
        maxDepth: Int,
        maxCount: Int,
        collected: inout [DetectedElement],
        counter: inout Int,
        warnings: inout [String]
    ) async {
        let appAX = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appAX, 3.0)
        AXUIElementSetAttributeValue(appAX, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(appAX, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        warnings.append("ax_manual_accessibility_set")

        var iteration = 0
        var prevCount = -1
        for i in 0..<3 {
            iteration = i
            if let webArea = findWebArea(appElement, maxDepth: 8) {
                _ = try? webArea.performAction(.press)
                // Drive focus into the web area so Blink schedules a full AX sync.
                AXUIElementSetAttributeValue(
                    webArea.underlyingElement,
                    kAXFocusedAttribute as CFString,
                    kCFBooleanTrue
                )
                guard !Task.isCancelled else { break }
                try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
                collected = []
                counter = 0
                walkTree(appElement, depth: 0, maxDepth: maxDepth, maxCount: maxCount, parentFrame: nil, collected: &collected, counter: &counter, parentId: nil)
                if collected.count >= 50 { break }
                if collected.count == prevCount { break }
                prevCount = collected.count
            }
        }
        warnings.append("web_wakeup_done_\(iteration + 1)x_\(collected.count)elems")
    }

    @MainActor
    private func walkTree(
        _ element: Element,
        depth: Int,
        maxDepth: Int,
        maxCount: Int,
        parentFrame: CGRect?,
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

        // AXGroup / AXGenericElement: reject elements that fill >90% of their parent —
        // those are transparent overlay containers, not meaningful UI nodes.
        let isContainerRole = Self.requiresLabelRoles.contains(role)
        let fillsParent: Bool = {
            guard isContainerRole, let pf = parentFrame, pf.width > 0, pf.height > 0 else { return false }
            let areaRatio = (bounds.width * bounds.height) / (pf.width * pf.height)
            return areaRatio > 0.9
        }()

        let isActionable = Self.actionableRoles.contains(role)
        let hasContent = (title != nil && !title!.isEmpty) || (desc != nil && !desc!.isEmpty) || (value != nil && !value!.isEmpty)

        // Container roles are only useful when they carry a visible label.
        let passesContainerFilter = !isContainerRole || (hasContent && !fillsParent)

        let currentFrame = frame  // pass down so children can check against parent

        if !isTooSmall && passesContainerFilter && (isActionable || hasContent) {
            counter += 1
            let elemId = "ax_\(counter)"
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
                        walkTree(child, depth: depth + 1, maxDepth: maxDepth, maxCount: maxCount, parentFrame: currentFrame, collected: &collected, counter: &counter, parentId: elemId)
                    }
                }
            }
        } else {
            if depth < maxDepth {
                if let children = element.children() {
                    for child in children {
                        guard collected.count < maxCount else { break }
                        walkTree(child, depth: depth + 1, maxDepth: maxDepth, maxCount: maxCount, parentFrame: currentFrame ?? parentFrame, collected: &collected, counter: &counter, parentId: parentId)
                    }
                }
            }
        }
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

// MARK: - Type Adapters

extension VisionDetectedElement {
    func toDetected() -> DetectedElement {
        DetectedElement(
            id: id,
            role: role,
            label: label,
            bounds: bounds,
            isEnabled: true,
            isActionable: role != "AXVisionRegion"
        )
    }
}

extension CDPDetectedElement {
    func toDetected() -> DetectedElement {
        let aid = attributes["id"]
        let elemBounds = Bounds(
            x: bounds.origin.x, y: bounds.origin.y,
            width: bounds.width, height: bounds.height
        )
        return DetectedElement(
            id: id,
            role: role,
            label: label,
            identifier: (aid?.isEmpty == false) ? aid : nil,
            bounds: elemBounds,
            isEnabled: true,
            isActionable: isVisible
        )
    }
}
