// Daemon.swift — daemon mode entry, called from main.swift in T9.
// For now, exposes a public function that T9 will invoke from main().
import Foundation
import SpectRAIClawCore

public func runDaemon(socketPath: String) async throws {
    // Ensure support directory exists
    let dir = URL(fileURLWithPath: socketPath).deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    try await DaemonCoordinator.shared.start(socketPath: socketPath)

    // Block until SIGTERM/SIGINT
    let signalQueue = DispatchQueue(label: "daemon.signals")
    let sigInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
    let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
    let semaphore = DispatchSemaphore(value: 0)
    sigInt.setEventHandler { semaphore.signal() }
    sigTerm.setEventHandler { semaphore.signal() }
    sigInt.resume()
    sigTerm.resume()
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    semaphore.wait()
    DaemonCoordinator.shared.stop()
}
