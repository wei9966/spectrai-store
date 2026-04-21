import Foundation

public final class Dispatcher: @unchecked Sendable {
    private let coordinator: DaemonCoordinator

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
            return Response(id: request.id, error: ResponseError(code: .eInternal, message: error.localizedDescription))
        }
    }

    private func dispatch(_ request: Request) async throws -> JSONValue {
        switch request.op {

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

        // T5/T6 ops — not yet implemented
        case OpName.captureScreen.rawValue,
             OpName.captureWindow.rawValue,
             OpName.captureArea.rawValue,
             OpName.detectElements.rawValue,
             OpName.getSnapshot.rawValue,
             OpName.listSnapshots.rawValue,
             OpName.cleanSnapshot.rawValue,
             OpName.click.rawValue,
             OpName.type.rawValue,
             OpName.hotkey.rawValue,
             OpName.scroll.rawValue,
             OpName.moveMouse.rawValue,
             OpName.waitForElement.rawValue,
             OpName.listApplications.rawValue,
             OpName.listWindows.rawValue,
             OpName.activateApplication.rawValue,
             OpName.focusWindow.rawValue,
             OpName.closeWindow.rawValue:
            throw DispatchError(code: .eOpUnsupported,
                                message: "op '\(request.op)' will be implemented in T5/T6")

        default:
            throw DispatchError(code: .eOpUnsupported,
                                message: "unknown op '\(request.op)'")
        }
    }
}

// MARK: - Helpers

private func encodeResult<T: Encodable>(_ value: T) throws -> JSONValue {
    let data = try JSONEncoder().encode(value)
    return try JSONDecoder().decode(JSONValue.self, from: data)
}

private struct DispatchError: Error {
    let code: ErrorCode
    let message: String
}
