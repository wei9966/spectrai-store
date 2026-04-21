import Foundation

public final class DaemonCoordinator: @unchecked Sendable {
    public static let shared = DaemonCoordinator()

    private let startTime = Date()
    private var socketHost: SocketHost?
    private var _dispatcher: Dispatcher?
    private var _connectionsActive: Int32 = 0
    private let syncQueue = DispatchQueue(label: "spectrai.claw.coordinator")

    private init() {}

    public var connectionsActive: Int32 {
        syncQueue.sync { _connectionsActive }
    }

    public var uptimeMs: Int64 {
        Int64(Date().timeIntervalSince(startTime) * 1000)
    }

    public func start(socketPath: String) async throws {
        // Ensure support directory exists
        let dir = URL(fileURLWithPath: socketPath).deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let dispatcher = Dispatcher(coordinator: self)
        let host = SocketHost(path: socketPath)

        host.onConnectionAccepted = { [weak self] in
            self?.syncQueue.async { self?._connectionsActive += 1 }
        }
        host.onConnectionClosed = { [weak self] in
            self?.syncQueue.async { self?._connectionsActive -= 1 }
        }

        try host.start(dispatcher: dispatcher)

        syncQueue.sync {
            self.socketHost = host
            self._dispatcher = dispatcher
        }
    }

    public func stop() {
        syncQueue.sync {
            socketHost?.stop()
            socketHost = nil
            _dispatcher = nil
        }
    }
}
