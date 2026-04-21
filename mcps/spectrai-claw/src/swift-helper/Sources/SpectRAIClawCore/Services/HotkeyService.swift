import CoreGraphics
import Foundation

public enum HotkeyError: Error, Sendable {
    case invalidKey(String)
    case eventCreationFailed(String)
}

public enum HotkeyService {
    public static let keyCodeMap: [String: UInt16] = [
        "return": 36, "enter": 36,
        "tab": 48,
        "escape": 53, "esc": 53,
        "delete": 51, "backspace": 51,
        "space": 49,
        "up": 126, "down": 125, "left": 123, "right": 124,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118,
        "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5,
        "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
        "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
        "j": 38, "k": 40, "n": 45, "m": 46,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21,
        "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42,
        ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "`": 50,
        "forwarddelete": 117, "home": 115, "end": 119,
        "pageup": 116, "pagedown": 121,
    ]

    private static let modifierNames: Set<String> = ["cmd", "command", "shift", "alt", "option", "opt", "ctrl", "control", "fn"]

    public static func press(keys: [String], holdMs: Int = 50) async throws {
        guard !keys.isEmpty else {
            throw HotkeyError.invalidKey("keys array is empty")
        }

        let normalized = keys.map { $0.lowercased() }

        var flags = CGEventFlags()
        var mainKeyCode: UInt16?

        for key in normalized {
            if modifierNames.contains(key) {
                switch key {
                case "cmd", "command": flags.insert(.maskCommand)
                case "shift": flags.insert(.maskShift)
                case "alt", "option", "opt": flags.insert(.maskAlternate)
                case "ctrl", "control": flags.insert(.maskControl)
                case "fn": flags.insert(.maskSecondaryFn)
                default: break
                }
            } else {
                guard let code = keyCodeMap[key] else {
                    throw HotkeyError.invalidKey("Unknown key: '\(key)'. Supported: \(keyCodeMap.keys.sorted().joined(separator: ", "))")
                }
                mainKeyCode = code
            }
        }

        let keyCode = mainKeyCode ?? 0

        guard let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
              let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
            throw HotkeyError.eventCreationFailed("Failed to create hotkey event")
        }

        downEvent.flags = flags
        upEvent.flags = flags

        downEvent.post(tap: .cghidEventTap)
        try await Task.sleep(nanoseconds: UInt64(holdMs) * 1_000_000)
        upEvent.post(tap: .cghidEventTap)
    }
}
