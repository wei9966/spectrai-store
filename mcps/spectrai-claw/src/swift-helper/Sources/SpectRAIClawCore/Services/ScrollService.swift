import CoreGraphics
import Foundation

public enum ScrollError: Error, Sendable {
    case eventCreationFailed(String)
}

public enum ScrollService {
    public enum Direction: String, Sendable {
        case up, down, left, right
    }

    public static func scroll(direction: Direction, amount: Int, at point: CGPoint? = nil) async throws {
        if let pt = point {
            guard let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left) else {
                throw ScrollError.eventCreationFailed("Failed to create mouse move event")
            }
            moveEvent.post(tap: .cghidEventTap)
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        let (wheel1, wheel2): (Int32, Int32) = {
            switch direction {
            case .up: return (Int32(amount), 0)
            case .down: return (-Int32(amount), 0)
            case .left: return (0, Int32(amount))
            case .right: return (0, -Int32(amount))
            }
        }()

        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: wheel1, wheel2: wheel2, wheel3: 0) else {
            throw ScrollError.eventCreationFailed("Failed to create scroll event")
        }
        event.post(tap: .cghidEventTap)
    }
}
