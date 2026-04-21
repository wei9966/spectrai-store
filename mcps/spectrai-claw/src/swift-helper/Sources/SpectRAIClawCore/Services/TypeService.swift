import CoreGraphics
import Foundation

public enum TypeServiceError: Error, Sendable {
    case eventCreationFailed(String)
}

public enum TypeService {
    public static func type(_ text: String, clearExisting: Bool = false, delayMsPerChar: Int = 0) async throws {
        if clearExisting {
            try await HotkeyService.press(keys: ["cmd", "a"], holdMs: 30)
            try await Task.sleep(nanoseconds: 50_000_000)
            try await HotkeyService.press(keys: ["delete"], holdMs: 30)
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        for char in text {
            let str = String(char)
            let chars = Array(str.utf16)

            guard let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                throw TypeServiceError.eventCreationFailed("Failed to create keyboard event")
            }

            downEvent.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            upEvent.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)

            downEvent.post(tap: .cghidEventTap)
            upEvent.post(tap: .cghidEventTap)

            if delayMsPerChar > 0 {
                try await Task.sleep(nanoseconds: UInt64(delayMsPerChar) * 1_000_000)
            } else {
                try await Task.sleep(nanoseconds: 5_000_000) // 5ms default
            }
        }
    }
}
