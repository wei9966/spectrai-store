import Foundation
import CoreGraphics
import ApplicationServices

public enum PermissionService {
    public static func screenRecording() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    public static func accessibility() -> Bool {
        AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): false] as CFDictionary
        )
    }

    public static func currentStatus() -> [String: Bool] {
        ["screenRecording": screenRecording(), "accessibility": accessibility()]
    }
}
