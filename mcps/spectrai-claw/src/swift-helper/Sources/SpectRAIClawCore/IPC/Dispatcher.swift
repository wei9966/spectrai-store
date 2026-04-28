import CoreGraphics
import Foundation

public final class Dispatcher: @unchecked Sendable {
    private let coordinator: DaemonCoordinator
    private let detectionService = ElementDetectionService()

    init(coordinator: DaemonCoordinator) {
        self.coordinator = coordinator
    }

    public func handle(_ request: Request) async -> Response {
        do {
            let result = try await dispatch(request)
            return Response(id: request.id, result: result)
        } catch let err as DispatchError {
            return Response(id: request.id, error: ResponseError(code: err.code, message: err.message))
        } catch {
            let de = mapServiceError(error)
            return Response(id: request.id, error: ResponseError(code: de.code, message: de.message))
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private func dispatch(_ request: Request) async throws -> JSONValue {
        switch request.op {

        // MARK: — System

        case OpName.ping.rawValue:
            return try encodeResult(PingResult(
                pong: true,
                timestamp: Int64(Date().timeIntervalSince1970 * 1000),
                daemonVersion: "0.2.0"
            ))

        case OpName.daemonStatus.rawValue:
            return try encodeResult(DaemonStatusResult(
                uptimeMs: coordinator.uptimeMs,
                pid: Int32(ProcessInfo.processInfo.processIdentifier),
                connectionsActive: coordinator.connectionsActive,
                protocolVersion: "1.0"
            ))

        case OpName.daemonStop.rawValue:
            Task { self.coordinator.stop() }
            return try encodeResult(DaemonStopResult(stopping: true))

        case OpName.permissionsStatus.rawValue:
            let status = PermissionService.currentStatus()
            return try encodeResult(PermissionsStatusResult(
                screenRecording: status["screenRecording"] ?? false,
                accessibility: status["accessibility"] ?? false
            ))

        // MARK: — Capture

        case OpName.captureScreen.rawValue:
            let p = try decodeParams(CaptureScreenParams.self, from: request.params)
            let r = try await ScreenCaptureService.captureScreen(
                displayIndex: p.displayIndex ?? 0,
                maxWidth: p.maxWidth
            )
            return try encodeResult(CaptureResult(
                path: r.path, width: r.width, height: r.height,
                displayBounds: boundsFromRect(r.displayBounds)
            ))

        case OpName.captureWindow.rawValue:
            let p = try decodeParams(CaptureWindowParams.self, from: request.params)
            let r = try await ScreenCaptureService.captureWindow(
                windowId: CGWindowID(p.windowId),
                maxWidth: p.maxWidth
            )
            return try encodeResult(CaptureResult(
                path: r.path, width: r.width, height: r.height,
                displayBounds: boundsFromRect(r.displayBounds)
            ))

        case OpName.captureArea.rawValue:
            let p = try decodeParams(CaptureAreaParams.self, from: request.params)
            let r = try await ScreenCaptureService.captureArea(
                CGRect(x: p.x, y: p.y, width: p.width, height: p.height),
                maxWidth: p.maxWidth
            )
            return try encodeResult(CaptureResult(
                path: r.path, width: r.width, height: r.height,
                displayBounds: boundsFromRect(r.displayBounds)
            ))

        // MARK: — Element Detection & Snapshots

        case OpName.detectElements.rawValue:
            let p = try decodeParams(DetectElementsParams.self, from: request.params)
            let detectionMode: DetectionMode = {
                guard let modeStr = p.mode, let m = DetectionMode(rawValue: modeStr) else { return .auto }
                return m
            }()
            let result = try await detectionService.detect(
                windowId: p.windowId.map { CGWindowID($0) },
                pid: p.pid.map { pid_t($0) },
                allowWebFocus: p.allowWebFocus ?? true,
                maxDepth: p.maxDepth ?? 8,
                maxCount: p.maxCount ?? 200,
                mode: detectionMode
            )
            let snapshotId = SnapshotManager.shared.createSnapshot()
            SnapshotManager.shared.storeDetectionResult(
                snapshotId: snapshotId, result: result,
                windowId: p.windowId.map { CGWindowID($0) }
            )
            return try encodeResult(DetectElementsResult(
                snapshotId: snapshotId,
                screenshotPath: result.screenshotPath,
                annotatedPath: result.annotatedPath ?? "",
                elements: result.elements,
                applicationName: result.applicationName,
                windowTitle: result.windowTitle,
                windowBounds: result.windowBounds,
                warnings: result.warnings,
                processId: result.processId
            ))

        case OpName.getSnapshot.rawValue:
            let p = try decodeParams(GetSnapshotParams.self, from: request.params)
            guard let r = SnapshotManager.shared.getDetectionResult(snapshotId: p.snapshotId) else {
                throw DispatchError(code: .eSnapshotStale,
                                    message: "Snapshot '\(p.snapshotId)' not found or expired")
            }
            return try encodeResult(DetectElementsResult(
                snapshotId: p.snapshotId,
                screenshotPath: r.screenshotPath,
                annotatedPath: r.annotatedPath ?? "",
                elements: r.elements,
                applicationName: r.applicationName,
                windowTitle: r.windowTitle,
                windowBounds: r.windowBounds,
                warnings: r.warnings,
                processId: r.processId
            ))

        case OpName.listSnapshots.rawValue:
            let snapshots = SnapshotManager.shared.listSnapshots()
            return try encodeResult(ListSnapshotsResult(snapshots: snapshots))

        case OpName.cleanSnapshot.rawValue:
            let p = try decodeParams(CleanSnapshotParams.self, from: request.params)
            let removed = SnapshotManager.shared.cleanSnapshot(p.snapshotId)
            return try encodeResult(CleanSnapshotResult(removed: removed))

        // MARK: — Actions

        case OpName.click.rawValue:
            let p = try decodeParams(ClickParams.self, from: request.params)
            let (point, target) = try resolveClickTarget(from: p)
            let button = parseButton(p.button)
            let clickType: ClickService.ClickType = p.clickCount >= 2 ? .double : .single
            let modifiers = parseModifiers(p.modifiers)

            if let sid = p.snapshotId, let eid = p.elementId,
               button == .left, clickType == .single, modifiers.isEmpty,
               let ref = SnapshotManager.shared.getElementReference(snapshotId: sid, elementId: eid),
               let pid = ref.processId, let axPath = ref.element.axPath {
                do {
                    try NativeAXActionService.press(pid: pid, axPath: axPath, expected: ref.element)
                    return try encodeResult(ClickResult(
                        clickedAt: ClickPoint(x: point.x, y: point.y),
                        targetElement: target,
                        method: "axPress"
                    ))
                } catch {
                    // Native AX actions are opportunistic; stale/unsupported elements fall back to HID click.
                }
            }

            try await ClickService.click(
                at: point,
                button: button,
                type: clickType,
                modifiers: modifiers
            )
            return try encodeResult(ClickResult(
                clickedAt: ClickPoint(x: point.x, y: point.y),
                targetElement: target,
                method: "hidClick"
            ))

        case OpName.type.rawValue:
            let p = try decodeParams(TypeParams.self, from: request.params)
            let method = "hidType"
            if let sid = p.snapshotId, let eid = p.elementId,
               let ref = SnapshotManager.shared.getElementReference(snapshotId: sid, elementId: eid) {
                if let pid = ref.processId, let axPath = ref.element.axPath {
                    do {
                        try NativeAXActionService.setValue(
                            pid: pid,
                            axPath: axPath,
                            expected: ref.element,
                            text: p.text,
                            clearExisting: p.clearExisting ?? false
                        )
                        return try encodeResult(TypeResult(typedChars: p.text.count, method: "axSetValue"))
                    } catch {
                        // Fall through to the existing focus-by-click + CGEvent typing path.
                    }
                }

                let elem = ref.element
                let pt = CGPoint(
                    x: elem.bounds.x + elem.bounds.width / 2,
                    y: elem.bounds.y + elem.bounds.height / 2
                )
                try await ClickService.click(at: pt)
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            try await TypeService.type(
                p.text,
                clearExisting: p.clearExisting ?? false,
                delayMsPerChar: p.delayMsPerChar ?? 0
            )
            return try encodeResult(TypeResult(typedChars: p.text.count, method: method))

        case OpName.hotkey.rawValue:
            let p = try decodeParams(HotkeyParams.self, from: request.params)
            try await HotkeyService.press(keys: p.keys, holdMs: p.holdMs ?? 50)
            return try encodeResult(HotkeyResult(ok: true))

        case OpName.scroll.rawValue:
            let p = try decodeParams(ScrollParams.self, from: request.params)
            guard let dir = ScrollService.Direction(rawValue: p.direction.lowercased()) else {
                throw DispatchError(code: .eInvalidArgs,
                                    message: "Invalid scroll direction: '\(p.direction)'")
            }
            let at: CGPoint? = (p.x != nil && p.y != nil) ? CGPoint(x: p.x!, y: p.y!) : nil
            try await ScrollService.scroll(direction: dir, amount: Int(p.amount), at: at)
            return try encodeResult(ScrollResult(ok: true))

        case OpName.moveMouse.rawValue:
            let p = try decodeParams(MoveMouseParams.self, from: request.params)
            let pt = CGPoint(x: p.x, y: p.y)
            guard let ev = CGEvent(
                mouseEventSource: nil, mouseType: .mouseMoved,
                mouseCursorPosition: pt, mouseButton: .left
            ) else {
                throw DispatchError(code: .eInternal, message: "Failed to create mouse move event")
            }
            ev.post(tap: .cghidEventTap)
            return try encodeResult(MoveMouseResult(ok: true))

        case OpName.waitForElement.rawValue:
            let p = try decodeParams(WaitForElementParams.self, from: request.params)
            let maxIter = max(1, (p.timeoutMs ?? 5000) / 200)
            var found: DetectedElement? = nil
            if let sid = p.snapshotId {
                for _ in 0..<maxIter {
                    let ms = SnapshotManager.shared.findElements(
                        snapshotId: sid, role: p.query.role,
                        label: p.query.label, identifier: p.query.identifier
                    )
                    if let first = ms.first { found = first; break }
                    try await Task.sleep(nanoseconds: 200_000_000)
                }
            } else {
                for _ in 0..<maxIter {
                    let sid = SnapshotManager.shared.createSnapshot()
                    let r = try await detectionService.detect()
                    SnapshotManager.shared.storeDetectionResult(snapshotId: sid, result: r)
                    let ms = SnapshotManager.shared.findElements(
                        snapshotId: sid, role: p.query.role,
                        label: p.query.label, identifier: p.query.identifier
                    )
                    if let first = ms.first { found = first; break }
                    try await Task.sleep(nanoseconds: 200_000_000)
                }
            }
            return try encodeResult(WaitForElementResult(found: found != nil, element: found))

        // MARK: — Application / Window

        case OpName.listApplications.rawValue:
            let apps = await MainActor.run { ApplicationService.list() }
            return try encodeResult(ListApplicationsResult(applications: apps))

        case OpName.listWindows.rawValue:
            let p = try decodeParams(ListWindowsParams.self, from: request.params)
            let wins = await MainActor.run { WindowService.list(pid: p.pid.map { pid_t($0) }) }
            return try encodeResult(ListWindowsResult(windows: wins))

        case OpName.activateApplication.rawValue:
            let p = try decodeParams(ActivateApplicationParams.self, from: request.params)
            _ = try await ApplicationService.activate(
                pid: p.pid.map { pid_t($0) },
                bundleId: p.bundleId
            )
            return try encodeResult(ActivateApplicationResult(ok: true))

        case OpName.focusWindow.rawValue:
            let p = try decodeParams(FocusWindowParams.self, from: request.params)
            try await WindowService.focus(windowId: CGWindowID(p.windowId))
            return try encodeResult(FocusWindowResult(ok: true))

        case OpName.closeWindow.rawValue:
            let p = try decodeParams(CloseWindowParams.self, from: request.params)
            try await WindowService.close(windowId: CGWindowID(p.windowId))
            return try encodeResult(CloseWindowResult(ok: true))

        default:
            throw DispatchError(code: .eOpUnsupported, message: "unknown op '\(request.op)'")
        }
    }
}

// MARK: - File-scope helpers

private func encodeResult<T: Encodable>(_ value: T) throws -> JSONValue {
    let data = try JSONEncoder().encode(value)
    return try JSONDecoder().decode(JSONValue.self, from: data)
}

private func decodeParams<T: Decodable>(_ type: T.Type, from value: JSONValue) throws -> T {
    let data = try JSONEncoder().encode(value)
    do {
        return try JSONDecoder().decode(type, from: data)
    } catch {
        throw DispatchError(code: .eInvalidArgs,
                            message: "Invalid params: \(error.localizedDescription)")
    }
}

private func boundsFromRect(_ rect: CGRect) -> Bounds {
    Bounds(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height)
}

private func resolveClickTarget(from p: ClickParams) throws -> (CGPoint, DetectedElement?) {
    if let sid = p.snapshotId, let eid = p.elementId {
        guard let elem = SnapshotManager.shared.getElement(snapshotId: sid, elementId: eid) else {
            throw DispatchError(code: .eNotFound,
                                message: "Element '\(eid)' not found in snapshot '\(sid)'")
        }
        let pt = CGPoint(
            x: elem.bounds.x + elem.bounds.width / 2,
            y: elem.bounds.y + elem.bounds.height / 2
        )
        return (pt, elem)
    }
    if let x = p.x, let y = p.y {
        return (CGPoint(x: x, y: y), nil)
    }
    throw DispatchError(code: .eInvalidArgs,
                        message: "click requires (snapshotId+elementId) or (x+y)")
}

private func parseButton(_ s: String) -> ClickService.Button {
    switch s.lowercased() {
    case "right": return .right
    case "middle": return .middle
    default: return .left
    }
}

private func parseModifiers(_ names: [String]) -> ClickService.Modifiers {
    var m = ClickService.Modifiers()
    for name in names {
        switch name.lowercased() {
        case "cmd", "command": m.insert(.cmd)
        case "shift": m.insert(.shift)
        case "option", "alt", "opt": m.insert(.option)
        case "ctrl", "control": m.insert(.control)
        default: break
        }
    }
    return m
}

private func mapServiceError(_ error: Error) -> DispatchError {
    switch error {
    case let e as ScreenCaptureError:
        switch e {
        case .permissionDenied(let m): return DispatchError(code: .ePermission, message: m)
        case .invalidArgs(let m): return DispatchError(code: .eInvalidArgs, message: m)
        case .captureFailed(let m): return DispatchError(code: .eInternal, message: m)
        }
    case let e as ElementDetectionError:
        switch e {
        case .axFailure(let m): return DispatchError(code: .eAXFailure, message: m)
        case .captureFailed(let m): return DispatchError(code: .eInternal, message: m)
        }
    case let e as ApplicationServiceError:
        switch e {
        case .notFound(let m): return DispatchError(code: .eNotFound, message: m)
        case .activationFailed(let m): return DispatchError(code: .eInternal, message: m)
        }
    case let e as WindowServiceError:
        switch e {
        case .notFound(let m): return DispatchError(code: .eNotFound, message: m)
        case .actionFailed(let m): return DispatchError(code: .eInternal, message: m)
        }
    case let e as HotkeyError:
        switch e {
        case .invalidKey(let m): return DispatchError(code: .eInvalidArgs, message: m)
        case .eventCreationFailed(let m): return DispatchError(code: .eInternal, message: m)
        }
    default:
        return DispatchError(code: .eInternal, message: error.localizedDescription)
    }
}

private struct DispatchError: Error {
    let code: ErrorCode
    let message: String
}
