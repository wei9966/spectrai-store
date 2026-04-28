import ApplicationServices
import CoreGraphics
import Foundation

public enum NativeAXActionError: Error, Sendable {
    case missingReference(String)
    case stale(String)
    case unsupported(String)
    case axFailure(String)
}

public enum NativeAXActionService {
    private static let messagingTimeout: Float = 0.4
    private static let textInputRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox",
    ]

    public static func press(pid: pid_t, axPath: [Int], expected: DetectedElement) throws {
        let element = try resolveElement(pid: pid, axPath: axPath, expected: expected)
        guard actionNames(of: element).contains(kAXPressAction as String) else {
            throw NativeAXActionError.unsupported("AXPress is not available for \(expected.role)")
        }

        let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard result == .success else {
            throw NativeAXActionError.axFailure("AXPress failed with code \(result.rawValue)")
        }
    }

    public static func setValue(pid: pid_t, axPath: [Int], expected: DetectedElement, text: String, clearExisting: Bool) throws {
        guard textInputRoles.contains(expected.role) else {
            throw NativeAXActionError.unsupported("AXSetValue is only enabled for text input roles, got \(expected.role)")
        }

        let element = try resolveElement(pid: pid, axPath: axPath, expected: expected)
        let actualRole = copyStringAttribute(element, kAXRoleAttribute as CFString) ?? expected.role
        guard textInputRoles.contains(actualRole) else {
            throw NativeAXActionError.stale("Resolved AX element role changed to \(actualRole)")
        }

        let newValue: String
        if clearExisting {
            newValue = text
        } else if let existing = copyValueString(element) {
            newValue = existing + text
        } else {
            throw NativeAXActionError.unsupported("Existing AXValue is not readable for append mode")
        }

        _ = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
        let focusResult = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        guard focusResult == .success || focusResult == .attributeUnsupported || focusResult == .actionUnsupported else {
            throw NativeAXActionError.axFailure("AXFocused failed with code \(focusResult.rawValue)")
        }

        var settable = DarwinBoolean(false)
        let settableResult = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        guard settableResult == .success, settable.boolValue else {
            throw NativeAXActionError.unsupported("AXValue is not settable")
        }

        let setResult = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, newValue as CFTypeRef)
        guard setResult == .success else {
            throw NativeAXActionError.axFailure("AXSetValue failed with code \(setResult.rawValue)")
        }
    }

    private static func resolveElement(pid: pid_t, axPath: [Int], expected: DetectedElement) throws -> AXUIElement {
        guard !axPath.isEmpty || expected.axPath != nil else {
            throw NativeAXActionError.missingReference("AX path missing")
        }

        var current = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(current, messagingTimeout)

        for index in axPath {
            guard index >= 0 else {
                throw NativeAXActionError.missingReference("Invalid AX path index \(index)")
            }
            let children = try copyChildren(current)
            guard index < children.count else {
                throw NativeAXActionError.stale("AX path index \(index) out of range")
            }
            current = children[index]
            AXUIElementSetMessagingTimeout(current, messagingTimeout)
        }

        try validate(current, expected: expected)
        return current
    }

    private static func copyChildren(_ element: AXUIElement) throws -> [AXUIElement] {
        var childrenRef: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef)
        guard result == .success else {
            throw NativeAXActionError.axFailure("AX children read failed with code \(result.rawValue)")
        }
        return (childrenRef as? [AXUIElement]) ?? []
    }

    private static func validate(_ element: AXUIElement, expected: DetectedElement) throws {
        let actualRole = copyStringAttribute(element, kAXRoleAttribute as CFString) ?? ""
        guard actualRole == expected.role else {
            throw NativeAXActionError.stale("Resolved AX role \(actualRole) != expected \(expected.role)")
        }

        let actualLabel = elementLabel(element)
        let labelOK = labelsMatch(expected.label, actualLabel)
        let boundsOK = boundsMatch(copyBounds(element), expected.bounds)

        if !labelOK && !boundsOK {
            throw NativeAXActionError.stale("Resolved AX element no longer matches expected label/bounds")
        }
    }

    private static func actionNames(of element: AXUIElement) -> [String] {
        var actionsRef: CFArray?
        let result = AXUIElementCopyActionNames(element, &actionsRef)
        guard result == .success else { return [] }
        return (actionsRef as? [String]) ?? []
    }

    private static func copyStringAttribute(_ element: AXUIElement, _ attr: CFString) -> String? {
        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attr, &valueRef) == .success else { return nil }
        if let s = valueRef as? String { return s }
        if let n = valueRef as? NSNumber { return n.stringValue }
        return nil
    }

    private static func copyValueString(_ element: AXUIElement) -> String? {
        copyStringAttribute(element, kAXValueAttribute as CFString)
    }

    private static func elementLabel(_ element: AXUIElement) -> String {
        let title = copyStringAttribute(element, kAXTitleAttribute as CFString)
        let description = copyStringAttribute(element, kAXDescriptionAttribute as CFString)
        let value = copyStringAttribute(element, kAXValueAttribute as CFString)
        return title ?? description ?? value ?? ""
    }

    private static func copyBounds(_ element: AXUIElement) -> Bounds? {
        var positionRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let positionRef,
              let sizeRef else {
            return nil
        }

        guard CFGetTypeID(positionRef) == AXValueGetTypeID(),
              CFGetTypeID(sizeRef) == AXValueGetTypeID() else {
            return nil
        }

        let positionValue = positionRef as! AXValue
        let sizeValue = sizeRef as! AXValue
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &point),
              AXValueGetValue(sizeValue, .cgSize, &size) else {
            return nil
        }

        return Bounds(x: point.x, y: point.y, width: size.width, height: size.height)
    }

    private static func labelsMatch(_ expected: String, _ actual: String) -> Bool {
        let e = normalize(expected)
        let a = normalize(actual)
        guard !e.isEmpty, !a.isEmpty else { return false }
        return e == a || e.contains(a) || a.contains(e)
    }

    private static func boundsMatch(_ actual: Bounds?, _ expected: Bounds) -> Bool {
        guard let actual else {
            return expected.width <= 0 || expected.height <= 0
        }
        guard actual.width > 0, actual.height > 0, expected.width > 0, expected.height > 0 else {
            return true
        }

        let ix1 = max(actual.x, expected.x)
        let iy1 = max(actual.y, expected.y)
        let ix2 = min(actual.x + actual.width, expected.x + expected.width)
        let iy2 = min(actual.y + actual.height, expected.y + expected.height)
        let interArea = max(0, ix2 - ix1) * max(0, iy2 - iy1)
        let unionArea = actual.width * actual.height + expected.width * expected.height - interArea
        let iou = unionArea > 0 ? interArea / unionArea : 0
        if iou >= 0.45 { return true }

        let actualCenter = CGPoint(x: actual.x + actual.width / 2, y: actual.y + actual.height / 2)
        let expectedCenter = CGPoint(x: expected.x + expected.width / 2, y: expected.y + expected.height / 2)
        let dx = actualCenter.x - expectedCenter.x
        let dy = actualCenter.y - expectedCenter.y
        return hypot(dx, dy) <= 12
    }

    private static func normalize(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .lowercased()
    }
}
