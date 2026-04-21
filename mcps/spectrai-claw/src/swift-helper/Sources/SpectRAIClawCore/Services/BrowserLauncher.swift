import AppKit
import Foundation

public enum BrowserLauncherError: Error, Sendable {
    case chromeNotInstalled
    case launchFailed(String)
}

public enum BrowserLauncher {
    private static let chromeBundleId = "com.google.Chrome"
    private static let chromeExecutablePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

    public static func findChromePIDs() -> [pid_t] {
        NSRunningApplication
            .runningApplications(withBundleIdentifier: chromeBundleId)
            .map(\.processIdentifier)
    }

    public static func restartChromeWithDebug(port: UInt16 = 9222) async throws -> pid_t {
        // 1) 优雅关闭已有 Chrome
        for pid in findChromePIDs() {
            _ = kill(pid, SIGTERM)
        }

        // 2) 等待旧进程退出（最多约 2s）
        for _ in 0..<20 {
            if findChromePIDs().isEmpty { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }

        // 3) 启动新进程并携带 remote-debugging-port
        guard FileManager.default.fileExists(atPath: chromeExecutablePath) else {
            throw BrowserLauncherError.chromeNotInstalled
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: chromeExecutablePath)

        let userDataDir = NSString(string: "~/Library/Application Support/Google/Chrome/").expandingTildeInPath
        process.arguments = [
            "--remote-debugging-port=\(port)",
            "--user-data-dir=\(userDataDir)",
        ]

        do {
            try process.run()
        } catch {
            throw BrowserLauncherError.launchFailed("Failed to launch Chrome with debug port: \(error.localizedDescription)")
        }

        if process.processIdentifier > 0 {
            return process.processIdentifier
        }

        // 兜底：从 NSRunningApplication 里再探测一次
        for _ in 0..<20 {
            if let pid = findChromePIDs().first(where: { $0 > 0 }) {
                return pid
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }

        throw BrowserLauncherError.launchFailed("Chrome process started but PID could not be resolved")
    }

    public static func detectOpenDebugPort() async -> UInt16 {
        await BrowserControlService.detectDebugPort(pid: 0)
    }
}
