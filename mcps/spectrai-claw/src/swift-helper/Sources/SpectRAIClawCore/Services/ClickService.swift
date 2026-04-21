import CoreGraphics
import Foundation

public enum ClickError: Error, Sendable {
    case eventCreationFailed(String)
}

public enum ClickService {
    public enum Button: String, Sendable {
        case left, right, middle
    }

    public enum ClickType: Sendable {
        case single, double
    }

    public struct Modifiers: OptionSet, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }

        public static let cmd = Modifiers(rawValue: 1 << 0)
        public static let shift = Modifiers(rawValue: 1 << 1)
        public static let option = Modifiers(rawValue: 1 << 2)
        public static let control = Modifiers(rawValue: 1 << 3)
    }

    public static func click(at point: CGPoint, button: Button = .left, type: ClickType = .single, modifiers: Modifiers = []) async throws {
        guard let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
            throw ClickError.eventCreationFailed("Failed to create mouse move event")
        }
        moveEvent.post(tap: .cghidEventTap)
        try await Task.sleep(nanoseconds: 20_000_000) // 20ms

        let (downType, upType, cgButton) = eventTypes(for: button)
        let clickCount = type == .double ? 2 : 1
        let flags = cgEventFlags(from: modifiers)

        for clickNum in 1...clickCount {
            guard let downEvent = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton),
                  let upEvent = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton) else {
                throw ClickError.eventCreationFailed("Failed to create click event")
            }

            downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickNum))
            upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickNum))

            if button == .middle {
                downEvent.setIntegerValueField(.mouseEventButtonNumber, value: 2)
                upEvent.setIntegerValueField(.mouseEventButtonNumber, value: 2)
            }

            if !modifiers.isEmpty {
                downEvent.flags = flags
                upEvent.flags = flags
            }

            downEvent.post(tap: .cghidEventTap)
            upEvent.post(tap: .cghidEventTap)

            if clickNum < clickCount {
                try await Task.sleep(nanoseconds: 30_000_000) // 30ms
            }
        }
    }

    private static func eventTypes(for button: Button) -> (CGEventType, CGEventType, CGMouseButton) {
        switch button {
        case .right: return (.rightMouseDown, .rightMouseUp, .right)
        case .middle: return (.otherMouseDown, .otherMouseUp, .center)
        case .left: return (.leftMouseDown, .leftMouseUp, .left)
        }
    }

    private static func cgEventFlags(from modifiers: Modifiers) -> CGEventFlags {
        var flags = CGEventFlags()
        if modifiers.contains(.cmd) { flags.insert(.maskCommand) }
        if modifiers.contains(.shift) { flags.insert(.maskShift) }
        if modifiers.contains(.option) { flags.insert(.maskAlternate) }
        if modifiers.contains(.control) { flags.insert(.maskControl) }
        return flags
    }
}
