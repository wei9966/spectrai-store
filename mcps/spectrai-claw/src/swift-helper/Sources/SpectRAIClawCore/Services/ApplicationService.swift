import AppKit
import Foundation

public enum ApplicationServiceError: Error, Sendable {
    case notFound(String)
    case activationFailed(String)
}

public enum ApplicationService {
    public static func list() -> [ApplicationInfo] {
        let apps = NSWorkspace.shared.runningApplications
        let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier

        return apps.compactMap { app in
            guard app.activationPolicy == .regular else { return nil }
            return ApplicationInfo(
                pid: app.processIdentifier,
                bundleId: app.bundleIdentifier ?? "",
                name: app.localizedName ?? "",
                isActive: app.processIdentifier == frontPid
            )
        }
    }

    @discardableResult
    public static func activate(pid: pid_t? = nil, bundleId: String? = nil) async throws -> pid_t {
        let app: NSRunningApplication?

        if let pid = pid {
            app = NSRunningApplication(processIdentifier: pid)
        } else if let bundleId = bundleId {
            app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
        } else {
            throw ApplicationServiceError.notFound("Either pid or bundleId must be provided")
        }

        guard let target = app else {
            throw ApplicationServiceError.notFound("Application not found (pid: \(pid?.description ?? "nil"), bundleId: \(bundleId ?? "nil"))")
        }

        let success = target.activate()
        if !success {
            throw ApplicationServiceError.activationFailed("Failed to activate \(target.localizedName ?? "app")")
        }

        return target.processIdentifier
    }
}
