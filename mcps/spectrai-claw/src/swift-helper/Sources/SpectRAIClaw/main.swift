import Foundation
import CoreGraphics
import AppKit
import Vision
import ApplicationServices
import SpectRAIClawCore

// MARK: - JSON Output Helpers

func jsonOutput(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        errorExit("Failed to serialize JSON output")
    }
}

func jsonOutputArray(_ arr: [[String: Any]]) {
    if let data = try? JSONSerialization.data(withJSONObject: arr, options: [.sortedKeys]),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        errorExit("Failed to serialize JSON output")
    }
}

func errorExit(_ message: String) -> Never {
    FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
    exit(1)
}

// MARK: - Argument Parsing Helpers

func getArg(_ name: String, args: [String]) -> String? {
    guard let idx = args.firstIndex(of: "--\(name)"), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

func hasFlag(_ name: String, args: [String]) -> Bool {
    return args.contains("--\(name)")
}

func requireArg(_ name: String, args: [String]) -> String {
    guard let val = getArg(name, args: args) else {
        errorExit("Missing required argument: --\(name)")
    }
    return val
}

// MARK: - Key Code Mapping

let keyCodeMap: [String: UInt16] = [
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

// MARK: - Screenshot Command

func cmdScreenshot(args: [String]) {
    let regionStr = getArg("region", args: args)
    let windowIdStr = getArg("window-id", args: args)
    let outputPath = getArg("output", args: args) ?? NSTemporaryDirectory() + "spectrai_screenshot_\(Int(Date().timeIntervalSince1970 * 1000)).png"

    var image: CGImage?

    if let windowIdStr = windowIdStr, let windowId = CGWindowID(windowIdStr) {
        // Capture specific window
        image = CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            windowId,
            [.boundsIgnoreFraming, .nominalResolution]
        )
    } else if let regionStr = regionStr {
        // Capture specific region
        let parts = regionStr.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 4 else { errorExit("Invalid region format. Use: x,y,w,h") }
        let rect = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
        image = CGWindowListCreateImage(
            rect,
            .optionOnScreenOnly,
            kCGNullWindowID,
            [.nominalResolution]
        )
    } else {
        // Full screen capture
        image = CGWindowListCreateImage(
            CGRect.infinite,
            .optionOnScreenOnly,
            kCGNullWindowID,
            [.nominalResolution]
        )
    }

    guard let cgImage = image else {
        errorExit("Failed to capture screenshot. Check screen recording permission.")
    }

    let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
    guard let pngData = bitmapRep.representation(using: .png, properties: [:]) else {
        errorExit("Failed to encode PNG")
    }

    let url = URL(fileURLWithPath: outputPath)
    do {
        try pngData.write(to: url)
    } catch {
        errorExit("Failed to write screenshot: \(error.localizedDescription)")
    }

    jsonOutput([
        "path": outputPath,
        "width": cgImage.width,
        "height": cgImage.height,
        "originX": 0,
        "originY": 0,
    ])
}

// MARK: - Mouse Commands

func cmdMouseMove(args: [String]) {
    let xStr = requireArg("x", args: args)
    let yStr = requireArg("y", args: args)
    guard let x = Double(xStr), let y = Double(yStr) else {
        errorExit("Invalid coordinates")
    }

    let point = CGPoint(x: x, y: y)
    guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
        errorExit("Failed to create mouse move event")
    }
    event.post(tap: .cghidEventTap)

    jsonOutput(["success": true, "x": x, "y": y])
}

func cmdMouseClick(args: [String]) {
    let xStr = requireArg("x", args: args)
    let yStr = requireArg("y", args: args)
    guard let x = Double(xStr), let y = Double(yStr) else {
        errorExit("Invalid coordinates")
    }
    let button = getArg("button", args: args) ?? "left"
    let count = Int(getArg("count", args: args) ?? "1") ?? 1

    let point = CGPoint(x: x, y: y)

    // Move to position first
    if let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        moveEvent.post(tap: .cghidEventTap)
        usleep(20000) // 20ms settle
    }

    let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) = {
        switch button {
        case "right":
            return (.rightMouseDown, .rightMouseUp, .right)
        case "middle":
            return (.otherMouseDown, .otherMouseUp, .center)
        default:
            return (.leftMouseDown, .leftMouseUp, .left)
        }
    }()

    for clickNum in 1...count {
        guard let downEvent = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton),
              let upEvent = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton) else {
            errorExit("Failed to create mouse click event")
        }
        downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickNum))
        upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickNum))

        if button == "middle" {
            downEvent.setIntegerValueField(.mouseEventButtonNumber, value: 2)
            upEvent.setIntegerValueField(.mouseEventButtonNumber, value: 2)
        }

        downEvent.post(tap: .cghidEventTap)
        upEvent.post(tap: .cghidEventTap)

        if clickNum < count {
            usleep(30000) // 30ms between clicks
        }
    }

    jsonOutput(["success": true, "x": x, "y": y, "button": button, "count": count])
}

func cmdMouseScroll(args: [String]) {
    let deltaYStr = requireArg("delta-y", args: args)
    guard let deltaY = Int32(deltaYStr) else {
        errorExit("Invalid delta-y value")
    }
    let deltaX = Int32(getArg("delta-x", args: args) ?? "0") ?? 0

    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) else {
        errorExit("Failed to create scroll event")
    }
    event.post(tap: .cghidEventTap)

    jsonOutput(["success": true, "deltaY": deltaY, "deltaX": deltaX])
}

// MARK: - Keyboard Commands

func cmdKeyType(args: [String]) {
    let text = requireArg("text", args: args)

    for char in text {
        let str = String(char)
        let chars = Array(str.utf16)

        guard let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            errorExit("Failed to create keyboard event")
        }

        downEvent.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
        upEvent.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)

        downEvent.post(tap: .cghidEventTap)
        upEvent.post(tap: .cghidEventTap)
        usleep(5000) // 5ms between characters
    }

    jsonOutput(["success": true, "text": text])
}

func parseModifierFlags(_ modStr: String) -> CGEventFlags {
    var flags = CGEventFlags()
    let mods = modStr.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    for mod in mods {
        switch mod {
        case "cmd", "command":
            flags.insert(.maskCommand)
        case "shift":
            flags.insert(.maskShift)
        case "alt", "option", "opt":
            flags.insert(.maskAlternate)
        case "ctrl", "control":
            flags.insert(.maskControl)
        case "fn":
            flags.insert(.maskSecondaryFn)
        default:
            break
        }
    }
    return flags
}

func cmdKeyPress(args: [String]) {
    let keyName = requireArg("key", args: args).lowercased()
    let modifiersStr = getArg("modifiers", args: args)

    guard let keyCode = keyCodeMap[keyName] else {
        errorExit("Unknown key name: \(keyName). Supported: \(keyCodeMap.keys.sorted().joined(separator: ", "))")
    }

    var flags = CGEventFlags()
    if let modifiersStr = modifiersStr {
        flags = parseModifierFlags(modifiersStr)
    }

    guard let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        errorExit("Failed to create key press event")
    }

    downEvent.flags = flags
    upEvent.flags = flags

    downEvent.post(tap: .cghidEventTap)
    upEvent.post(tap: .cghidEventTap)

    jsonOutput(["success": true, "key": keyName])
}

func cmdKeyHotkey(args: [String]) {
    let keysStr = requireArg("keys", args: args).lowercased()
    let parts = keysStr.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }

    guard parts.count >= 2 else {
        errorExit("Hotkey must have at least a modifier and a key, e.g. cmd+c")
    }

    let keyPart = parts.last!
    let modifierParts = parts.dropLast()

    guard let keyCode = keyCodeMap[keyPart] else {
        errorExit("Unknown key: \(keyPart)")
    }

    var flags = CGEventFlags()
    for mod in modifierParts {
        switch mod {
        case "cmd", "command":
            flags.insert(.maskCommand)
        case "shift":
            flags.insert(.maskShift)
        case "alt", "option", "opt":
            flags.insert(.maskAlternate)
        case "ctrl", "control":
            flags.insert(.maskControl)
        case "fn":
            flags.insert(.maskSecondaryFn)
        default:
            errorExit("Unknown modifier: \(mod)")
        }
    }

    guard let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        errorExit("Failed to create hotkey event")
    }

    downEvent.flags = flags
    upEvent.flags = flags

    downEvent.post(tap: .cghidEventTap)
    upEvent.post(tap: .cghidEventTap)

    jsonOutput(["success": true, "keys": keysStr])
}

// MARK: - Accessibility Tree

func axElementToDict(_ element: AXUIElement, depth: Int, maxDepth: Int, collected: inout [[String: Any]], maxElements: Int) {
    guard collected.count < maxElements, depth <= maxDepth else { return }

    var roleRef: CFTypeRef?
    var titleRef: CFTypeRef?
    var valueRef: CFTypeRef?
    var descRef: CFTypeRef?
    var positionRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    var enabledRef: CFTypeRef?
    var focusedRef: CFTypeRef?
    var subroleRef: CFTypeRef?

    AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
    AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef)
    AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef)
    AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &descRef)
    AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef)
    AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef)
    AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabledRef)
    AXUIElementCopyAttributeValue(element, kAXFocusedAttribute as CFString, &focusedRef)
    AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleRef)

    let role = roleRef as? String ?? ""
    let title = titleRef as? String ?? ""
    let value: String = {
        if let v = valueRef {
            if let s = v as? String { return s }
            if let n = v as? NSNumber { return n.stringValue }
            return "\(v)"
        }
        return ""
    }()
    let desc = descRef as? String ?? ""

    var bounds: [String: CGFloat] = ["x": 0, "y": 0, "width": 0, "height": 0]
    if let posRef = positionRef {
        var point = CGPoint.zero
        if AXValueGetValue(posRef as! AXValue, .cgPoint, &point) {
            bounds["x"] = point.x
            bounds["y"] = point.y
        }
    }
    if let szRef = sizeRef {
        var size = CGSize.zero
        if AXValueGetValue(szRef as! AXValue, .cgSize, &size) {
            bounds["width"] = size.width
            bounds["height"] = size.height
        }
    }

    let enabled = (enabledRef as? Bool) ?? true
    let focused = (focusedRef as? Bool) ?? false

    // Filter: skip elements that are too small and have no useful info
    let hasName = !title.isEmpty || !desc.isEmpty || !value.isEmpty
    let isClickable = ["AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton",
                       "AXPopUpButton", "AXComboBox", "AXTextField", "AXTextArea",
                       "AXSlider", "AXIncrementor", "AXTab"].contains(role)
    let isTooSmall = (bounds["width"] ?? 0) < 2 && (bounds["height"] ?? 0) < 2

    if !isTooSmall && (hasName || isClickable) {
        var dict: [String: Any] = [
            "role": role,
            "title": title,
            "value": value,
            "description": desc,
            "bounds": bounds,
            "enabled": enabled,
            "focused": focused,
        ]
        if let sr = subroleRef as? String, !sr.isEmpty {
            dict["subrole"] = sr
        }
        collected.append(dict)
    }

    // Recurse into children
    if depth < maxDepth {
        var childrenRef: CFTypeRef?
        let childResult = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef)
        if childResult == .success, let children = childrenRef as? [AXUIElement] {
            for child in children {
                guard collected.count < maxElements else { break }
                axElementToDict(child, depth: depth + 1, maxDepth: maxDepth, collected: &collected, maxElements: maxElements)
            }
        }
    }
}

func cmdAxTree(args: [String]) {
    let pidStr = requireArg("pid", args: args)
    guard let pid = pid_t(pidStr) else { errorExit("Invalid pid") }
    let maxDepth = Int(getArg("depth", args: args) ?? "5") ?? 5

    let app = AXUIElementCreateApplication(pid)
    var collected: [[String: Any]] = []
    axElementToDict(app, depth: 0, maxDepth: maxDepth, collected: &collected, maxElements: 80)

    jsonOutput(["elements": collected])
}

func cmdAxElementAt(args: [String]) {
    let xStr = requireArg("x", args: args)
    let yStr = requireArg("y", args: args)
    guard let x = Float(xStr), let y = Float(yStr) else {
        errorExit("Invalid coordinates")
    }

    let systemWide = AXUIElementCreateSystemWide()
    var elementRef: AXUIElement?
    let result = AXUIElementCopyElementAtPosition(systemWide, x, y, &elementRef)

    guard result == .success, let element = elementRef else {
        errorExit("No element found at position (\(x), \(y)). Error: \(result.rawValue)")
    }

    var collected: [[String: Any]] = []
    axElementToDict(element, depth: 0, maxDepth: 0, collected: &collected, maxElements: 1)

    if let dict = collected.first {
        jsonOutput(dict)
    } else {
        // Return minimal info if filter excluded the element
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        jsonOutput([
            "role": (roleRef as? String) ?? "Unknown",
            "title": "",
            "value": "",
            "description": "",
            "frame": ["x": 0, "y": 0, "w": 0, "h": 0],
            "enabled": true,
            "focused": false,
        ])
    }
}

// MARK: - OCR Command

func cmdOCR(args: [String]) {
    let imagePath = requireArg("image", args: args)
    let languagesStr = getArg("languages", args: args) ?? "en-US"
    let languages = languagesStr.split(separator: ",").map { String($0.trimmingCharacters(in: .whitespaces)) }

    guard let image = NSImage(contentsOfFile: imagePath),
          let tiffData = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiffData),
          let cgImage = bitmap.cgImage else {
        errorExit("Failed to load image: \(imagePath)")
    }

    let imageWidth = CGFloat(cgImage.width)
    let imageHeight = CGFloat(cgImage.height)

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        errorExit("OCR failed: \(error.localizedDescription)")
    }

    var results: [[String: Any]] = []
    if let observations = request.results {
        for obs in observations {
            guard let topCandidate = obs.topCandidates(1).first else { continue }

            // Convert Vision normalized coordinates (origin bottom-left) to pixel coordinates (origin top-left)
            let box = obs.boundingBox
            let pixelX = box.origin.x * imageWidth
            let pixelY = (1.0 - box.origin.y - box.height) * imageHeight
            let pixelW = box.width * imageWidth
            let pixelH = box.height * imageHeight

            results.append([
                "text": topCandidate.string,
                "confidence": topCandidate.confidence,
                "bounds": [
                    "x": Int(pixelX),
                    "y": Int(pixelY),
                    "width": Int(pixelW),
                    "height": Int(pixelH),
                ],
            ])
        }
    }

    jsonOutput(["results": results])
}

// MARK: - Window Commands

func cmdWindowsList() {
    guard let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        errorExit("Failed to get window list")
    }

    var windows: [[String: Any]] = []
    for win in windowList {
        guard let layer = win[kCGWindowLayer as String] as? Int else { continue }
        // Only include normal windows (layer 0) and slightly above
        guard layer <= 8 else { continue }

        let windowId = win[kCGWindowNumber as String] as? Int ?? 0
        let ownerName = win[kCGWindowOwnerName as String] as? String ?? ""
        let ownerPid = win[kCGWindowOwnerPID as String] as? Int ?? 0
        let title = win[kCGWindowName as String] as? String ?? ""

        var bounds: [String: Any] = ["x": 0, "y": 0, "w": 0, "h": 0]
        if let boundsDict = win[kCGWindowBounds as String] as? [String: Any] {
            bounds["x"] = boundsDict["X"] ?? 0
            bounds["y"] = boundsDict["Y"] ?? 0
            bounds["w"] = boundsDict["Width"] ?? 0
            bounds["h"] = boundsDict["Height"] ?? 0
        }

        windows.append([
            "windowId": windowId,
            "ownerName": ownerName,
            "ownerPid": ownerPid,
            "title": title,
            "bounds": bounds,
            "layer": layer,
        ])
    }

    jsonOutput(["windows": windows])
}

func cmdWindowFocus(args: [String]) {
    let pidStr = requireArg("pid", args: args)
    guard let pid = pid_t(pidStr) else { errorExit("Invalid pid") }
    let titleFilter = getArg("title", args: args)

    guard let app = NSRunningApplication(processIdentifier: pid) else {
        errorExit("No application found with pid \(pid)")
    }

    let success = app.activate(options: .activateIgnoringOtherApps)
    if !success {
        errorExit("Failed to activate application with pid \(pid)")
    }

    // If title is specified, try to raise the specific window via AXUIElement
    if let titleFilter = titleFilter {
        usleep(100000) // 100ms for activation
        let axApp = AXUIElementCreateApplication(pid)
        var windowsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let windows = windowsRef as? [AXUIElement] {
            for window in windows {
                var titleRef: CFTypeRef?
                AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleRef)
                if let windowTitle = titleRef as? String, windowTitle.contains(titleFilter) {
                    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                    break
                }
            }
        }
    }

    jsonOutput(["success": true, "pid": Int(pid)])
}

func cmdWindowClose(args: [String]) {
    let pidStr = requireArg("pid", args: args)
    guard let pid = pid_t(pidStr) else { errorExit("Invalid pid") }
    let titleFilter = getArg("title", args: args)

    let axApp = AXUIElementCreateApplication(pid)
    var windowsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsRef) == .success,
          let windows = windowsRef as? [AXUIElement] else {
        errorExit("Could not access windows for pid \(pid)")
    }

    var closed = false
    for window in windows {
        if let titleFilter = titleFilter {
            var titleRef: CFTypeRef?
            AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleRef)
            guard let windowTitle = titleRef as? String, windowTitle.contains(titleFilter) else {
                continue
            }
        }

        // Find the close button
        var closeButtonRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(window, kAXCloseButtonAttribute as CFString, &closeButtonRef) == .success,
           let closeButton = closeButtonRef {
            let btn = closeButton as! AXUIElement
            if AXUIElementPerformAction(btn, kAXPressAction as CFString) == .success {
                closed = true
                break
            }
        }
    }

    if !closed {
        // Fallback: use AppleScript
        if let app = NSRunningApplication(processIdentifier: pid) {
            let appName = app.localizedName ?? ""
            if !appName.isEmpty {
                let script: String
                if let titleFilter = titleFilter {
                    script = "tell application \"\(appName)\" to close (first window whose name contains \"\(titleFilter)\")"
                } else {
                    script = "tell application \"\(appName)\" to close front window"
                }
                if let appleScript = NSAppleScript(source: script) {
                    var errorDict: NSDictionary?
                    appleScript.executeAndReturnError(&errorDict)
                    if errorDict == nil {
                        closed = true
                    }
                }
            }
        }
    }

    if closed {
        jsonOutput(["success": true, "pid": Int(pid)])
    } else {
        errorExit("Failed to close window for pid \(pid)")
    }
}

// MARK: - Screen Info

func cmdScreenInfo() {
    var screens: [[String: Any]] = []

    for (index, screen) in NSScreen.screens.enumerated() {
        let frame = screen.frame
        let visibleFrame = screen.visibleFrame
        let scaleFactor = screen.backingScaleFactor

        screens.append([
            "id": index,
            "width": Int(frame.width),
            "height": Int(frame.height),
            "scaleFactor": scaleFactor,
            "isPrimary": index == 0,
            "frame": [
                "x": Int(frame.origin.x),
                "y": Int(frame.origin.y),
                "w": Int(frame.width),
                "h": Int(frame.height),
            ],
            "visibleFrame": [
                "x": Int(visibleFrame.origin.x),
                "y": Int(visibleFrame.origin.y),
                "w": Int(visibleFrame.width),
                "h": Int(visibleFrame.height),
            ],
        ])
    }

    jsonOutput(["screens": screens])
}

// MARK: - Permissions Check

func cmdPermissionsCheck() {
    // Check accessibility permission
    let accessibilityEnabled = AXIsProcessTrustedWithOptions(
        [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): false] as CFDictionary
    )

    // Check screen recording permission
    var screenRecordingEnabled = false
    if #available(macOS 15.0, *) {
        screenRecordingEnabled = CGPreflightScreenCaptureAccess()
    } else {
        // For older macOS, try a small capture and check if it succeeds
        let testImage = CGWindowListCreateImage(
            CGRect(x: 0, y: 0, width: 1, height: 1),
            .optionOnScreenOnly,
            kCGNullWindowID,
            []
        )
        screenRecordingEnabled = testImage != nil
    }

    jsonOutput([
        "accessibility": accessibilityEnabled,
        "screenRecording": screenRecordingEnabled,
    ])
}

// MARK: - Accessibility Actions

/// Recursively search for an AX element matching criteria, return it
func axFindElement(_ root: AXUIElement, title: String?, role: String?, value: String?, depth: Int, maxDepth: Int) -> AXUIElement? {
    guard depth <= maxDepth else { return nil }

    var roleRef: CFTypeRef?
    var titleRef: CFTypeRef?
    var valueRef: CFTypeRef?
    var descRef: CFTypeRef?
    AXUIElementCopyAttributeValue(root, kAXRoleAttribute as CFString, &roleRef)
    AXUIElementCopyAttributeValue(root, kAXTitleAttribute as CFString, &titleRef)
    AXUIElementCopyAttributeValue(root, kAXValueAttribute as CFString, &valueRef)
    AXUIElementCopyAttributeValue(root, kAXDescriptionAttribute as CFString, &descRef)

    let elRole = roleRef as? String ?? ""
    let elTitle = titleRef as? String ?? ""
    let elValue: String = {
        if let v = valueRef {
            if let s = v as? String { return s }
            if let n = v as? NSNumber { return n.stringValue }
            return "\(v)"
        }
        return ""
    }()
    let elDesc = descRef as? String ?? ""

    var matched = true
    if let title = title, !title.isEmpty {
        let lower = title.lowercased()
        if !elTitle.lowercased().contains(lower) && !elDesc.lowercased().contains(lower) && !elValue.lowercased().contains(lower) {
            matched = false
        }
    }
    if let role = role, !role.isEmpty {
        if !elRole.lowercased().contains(role.lowercased()) {
            matched = false
        }
    }
    if let value = value, !value.isEmpty {
        if !elValue.lowercased().contains(value.lowercased()) {
            matched = false
        }
    }

    if matched && (title != nil || role != nil || value != nil) {
        return root
    }

    // Recurse children
    var childrenRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(root, kAXChildrenAttribute as CFString, &childrenRef) == .success,
       let children = childrenRef as? [AXUIElement] {
        for child in children {
            if let found = axFindElement(child, title: title, role: role, value: value, depth: depth + 1, maxDepth: maxDepth) {
                return found
            }
        }
    }
    return nil
}

func axElementInfo(_ element: AXUIElement) -> [String: Any] {
    var roleRef: CFTypeRef?
    var titleRef: CFTypeRef?
    var valueRef: CFTypeRef?
    var descRef: CFTypeRef?
    var positionRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
    AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef)
    AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef)
    AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &descRef)
    AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef)
    AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef)

    var bounds: [String: CGFloat] = ["x": 0, "y": 0, "width": 0, "height": 0]
    if let posRef = positionRef {
        var point = CGPoint.zero
        if AXValueGetValue(posRef as! AXValue, .cgPoint, &point) {
            bounds["x"] = point.x; bounds["y"] = point.y
        }
    }
    if let szRef = sizeRef {
        var size = CGSize.zero
        if AXValueGetValue(szRef as! AXValue, .cgSize, &size) {
            bounds["width"] = size.width; bounds["height"] = size.height
        }
    }

    let elValue: String = {
        if let v = valueRef {
            if let s = v as? String { return s }
            if let n = v as? NSNumber { return n.stringValue }
            return "\(v)"
        }
        return ""
    }()

    return [
        "role": roleRef as? String ?? "",
        "title": titleRef as? String ?? "",
        "value": elValue,
        "description": descRef as? String ?? "",
        "bounds": bounds,
    ]
}

/// ax-press: Find element and perform AXPress action
func cmdAxPress(args: [String]) {
    let pidStr = requireArg("pid", args: args)
    guard let pid = pid_t(pidStr) else { errorExit("Invalid pid") }
    let title = getArg("title", args: args)
    let role = getArg("role", args: args)
    let maxDepth = Int(getArg("depth", args: args) ?? "8") ?? 8

    let app = AXUIElementCreateApplication(pid)
    guard let element = axFindElement(app, title: title, role: role, value: nil, depth: 0, maxDepth: maxDepth) else {
        errorExit("Element not found with title=\(title ?? "nil"), role=\(role ?? "nil")")
    }

    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if result != .success {
        errorExit("AXPress failed with error code: \(result.rawValue)")
    }

    let info = axElementInfo(element)
    jsonOutput(["success": true, "action": "press", "element": info])
}

/// ax-set-value: Find element and set its AXValue (for text fields)
func cmdAxSetValue(args: [String]) {
    let pidStr = requireArg("pid", args: args)
    guard let pid = pid_t(pidStr) else { errorExit("Invalid pid") }
    let newValue = requireArg("value", args: args)
    let title = getArg("title", args: args)
    let role = getArg("role", args: args)
    let maxDepth = Int(getArg("depth", args: args) ?? "8") ?? 8

    let app = AXUIElementCreateApplication(pid)
    guard let element = axFindElement(app, title: title, role: role, value: nil, depth: 0, maxDepth: maxDepth) else {
        errorExit("Element not found with title=\(title ?? "nil"), role=\(role ?? "nil")")
    }

    // Focus the element first
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)
    usleep(50000) // 50ms

    // Set value
    let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, newValue as CFTypeRef)
    if result != .success {
        errorExit("AXSetValue failed with error code: \(result.rawValue)")
    }

    let info = axElementInfo(element)
    jsonOutput(["success": true, "action": "setValue", "newValue": newValue, "element": info])
}

/// ax-focus: Find element and set focus
func cmdAxFocus(args: [String]) {
    let pidStr = requireArg("pid", args: args)
    guard let pid = pid_t(pidStr) else { errorExit("Invalid pid") }
    let title = getArg("title", args: args)
    let role = getArg("role", args: args)
    let maxDepth = Int(getArg("depth", args: args) ?? "8") ?? 8

    let app = AXUIElementCreateApplication(pid)
    guard let element = axFindElement(app, title: title, role: role, value: nil, depth: 0, maxDepth: maxDepth) else {
        errorExit("Element not found with title=\(title ?? "nil"), role=\(role ?? "nil")")
    }

    // Try raise action first (for windows)
    AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    // Then set focused
    let result = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)
    if result != .success {
        errorExit("AXFocus failed with error code: \(result.rawValue)")
    }

    let info = axElementInfo(element)
    jsonOutput(["success": true, "action": "focus", "element": info])
}

/// ax-actions: List available actions for an element
func cmdAxActions(args: [String]) {
    let pidStr = requireArg("pid", args: args)
    guard let pid = pid_t(pidStr) else { errorExit("Invalid pid") }
    let title = getArg("title", args: args)
    let role = getArg("role", args: args)
    let maxDepth = Int(getArg("depth", args: args) ?? "8") ?? 8

    let app = AXUIElementCreateApplication(pid)
    guard let element = axFindElement(app, title: title, role: role, value: nil, depth: 0, maxDepth: maxDepth) else {
        errorExit("Element not found with title=\(title ?? "nil"), role=\(role ?? "nil")")
    }

    var actionsRef: CFArray?
    AXUIElementCopyActionNames(element, &actionsRef)
    let actions = (actionsRef as? [String]) ?? []

    var attrsRef: CFArray?
    AXUIElementCopyAttributeNames(element, &attrsRef)
    let settableAttrs: [String] = {
        guard let attrs = attrsRef as? [String] else { return [] }
        return attrs.filter { attr in
            var settable: DarwinBoolean = false
            AXUIElementIsAttributeSettable(element, attr as CFString, &settable)
            return settable.boolValue
        }
    }()

    let info = axElementInfo(element)
    jsonOutput([
        "element": info,
        "actions": actions,
        "settableAttributes": settableAttrs,
    ])
}

// MARK: - Daemon Helpers

func defaultSocketPath() -> String {
    let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
    let dir = appSupport.appendingPathComponent("spectrai-claw")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("claw.sock").path
}

func cmdDaemon(args: [String]) -> Never {
    guard let subcommand = args.first else {
        errorExit("Usage: spectrai-claw-helper daemon <run|status|stop> [options]")
    }

    let daemonArgs = Array(args.dropFirst())

    switch subcommand {
    case "run":
        let socketPath = getArg("socket", args: daemonArgs) ?? defaultSocketPath()
        Task {
            do {
                try await runDaemon(socketPath: socketPath)
                exit(0)
            } catch {
                FileHandle.standardError.write(Data("Daemon failed: \(error)\n".utf8))
                exit(1)
            }
        }
        RunLoop.main.run()
        exit(0)
    case "status":
        let socketPath = getArg("socket", args: daemonArgs) ?? defaultSocketPath()
        jsonOutput(["status": "use-ts-client", "socketPath": socketPath])
        exit(0)
    case "stop":
        let socketPath = getArg("socket", args: daemonArgs) ?? defaultSocketPath()
        jsonOutput(["stop": "use-ts-client", "socketPath": socketPath])
        exit(0)
    default:
        errorExit("Unknown daemon subcommand: \(subcommand). Use: run, status, stop")
    }
}

// MARK: - Main Entry Point

let arguments = Array(CommandLine.arguments.dropFirst())

guard let command = arguments.first else {
    FileHandle.standardError.write(Data("""
    Usage: spectrai-claw-helper <command> [options]

    Commands:
      daemon         Run as persistent daemon (daemon run|status|stop)
      screenshot     Capture screen, window, or region
      mouse-move     Move mouse cursor
      mouse-click    Click mouse button
      mouse-scroll   Scroll mouse wheel
      key-type       Type text (supports Unicode)
      key-press      Press a single key with optional modifiers
      key-hotkey     Press a hotkey combination
      ax-tree        Get accessibility tree for a process
      ax-element-at  Get element at screen position
      ocr            OCR text recognition on an image
      windows        List visible windows
      window-focus   Focus/activate a window
      window-close   Close a window
      screen-info    Get display information
      permissions    Check system permissions

    """.utf8))
    exit(1)
}

let subArgs = Array(arguments.dropFirst())

switch command {
case "daemon":
    cmdDaemon(args: subArgs)
case "screenshot":
    cmdScreenshot(args: subArgs)
case "mouse-move":
    cmdMouseMove(args: subArgs)
case "mouse-click":
    cmdMouseClick(args: subArgs)
case "mouse-scroll":
    cmdMouseScroll(args: subArgs)
case "key-type":
    cmdKeyType(args: subArgs)
case "key-press":
    cmdKeyPress(args: subArgs)
case "key-hotkey":
    cmdKeyHotkey(args: subArgs)
case "ax-tree":
    cmdAxTree(args: subArgs)
case "ax-element-at":
    cmdAxElementAt(args: subArgs)
case "ax-press":
    cmdAxPress(args: subArgs)
case "ax-set-value":
    cmdAxSetValue(args: subArgs)
case "ax-focus":
    cmdAxFocus(args: subArgs)
case "ax-actions":
    cmdAxActions(args: subArgs)
case "ocr":
    cmdOCR(args: subArgs)
case "windows":
    if subArgs.first == "list" || subArgs.isEmpty {
        cmdWindowsList()
    } else {
        errorExit("Unknown windows subcommand: \(subArgs.first ?? "")")
    }
case "window-focus":
    cmdWindowFocus(args: subArgs)
case "window-close":
    cmdWindowClose(args: subArgs)
case "screen-info":
    cmdScreenInfo()
case "permissions":
    if subArgs.first == "check" || subArgs.isEmpty {
        cmdPermissionsCheck()
    } else {
        errorExit("Unknown permissions subcommand: \(subArgs.first ?? "")")
    }
default:
    errorExit("Unknown command: \(command)")
}
