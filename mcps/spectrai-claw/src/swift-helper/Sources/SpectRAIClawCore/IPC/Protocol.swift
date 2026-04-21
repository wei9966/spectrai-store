import Foundation

// MARK: - Frame Encoding/Decoding

public let kMaxFrameSize: UInt32 = 64 * 1024 * 1024 // 64 MiB

public enum FrameError: Error {
    case messageTooLarge(UInt32)
    case insufficientData
    case invalidUTF8
}

public func encodeFrame(_ payload: Data) throws -> Data {
    let length = UInt32(payload.count)
    guard length <= kMaxFrameSize else {
        throw FrameError.messageTooLarge(length)
    }
    var header = Data(count: 4)
    header[0] = UInt8((length >> 24) & 0xFF)
    header[1] = UInt8((length >> 16) & 0xFF)
    header[2] = UInt8((length >> 8) & 0xFF)
    header[3] = UInt8(length & 0xFF)
    return header + payload
}

public func decodeFrame(_ data: Data) throws -> (body: Data, rest: Data)? {
    guard data.count >= 4 else { return nil }
    let length = UInt32(data[data.startIndex]) << 24
        | UInt32(data[data.startIndex + 1]) << 16
        | UInt32(data[data.startIndex + 2]) << 8
        | UInt32(data[data.startIndex + 3])
    guard length <= kMaxFrameSize else {
        throw FrameError.messageTooLarge(length)
    }
    let totalNeeded = 4 + Int(length)
    guard data.count >= totalNeeded else { return nil }
    let bodyStart = data.startIndex + 4
    let bodyEnd = data.startIndex + totalNeeded
    let body = data[bodyStart ..< bodyEnd]
    let rest = data[bodyEnd ..< data.endIndex]
    return (Data(body), Data(rest))
}

// MARK: - JSON Value (AnyCodable equivalent)

public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? container.decode(Int64.self) {
            self = .int(i)
        } else if let d = try? container.decode(Double.self) {
            self = .double(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let arr = try? container.decode([JSONValue].self) {
            self = .array(arr)
        } else if let obj = try? container.decode([String: JSONValue].self) {
            self = .object(obj)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Cannot decode JSONValue")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let v): try container.encode(v)
        case .int(let v): try container.encode(v)
        case .double(let v): try container.encode(v)
        case .string(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        }
    }
}

// MARK: - Error Codes

public enum ErrorCode: String, Codable, CaseIterable, Sendable {
    case ePermission
    case eNotFound
    case eInvalidArgs
    case eTimeout
    case eAXFailure
    case eInternal
    case eOpUnsupported
    case eSnapshotStale
}

// MARK: - Request / Response

public struct Request: Codable, Sendable {
    public let id: String
    public let op: String
    public let params: JSONValue

    public init(id: String, op: String, params: JSONValue) {
        self.id = id
        self.op = op
        self.params = params
    }
}

public struct ResponseError: Codable, Sendable {
    public let code: ErrorCode
    public let message: String
    public let details: String?

    public init(code: ErrorCode, message: String, details: String? = nil) {
        self.code = code
        self.message = message
        self.details = details
    }
}

public struct Response: Codable, Sendable {
    public let id: String
    public let ok: Bool
    public let result: JSONValue?
    public let error: ResponseError?

    public init(id: String, result: JSONValue) {
        self.id = id
        self.ok = true
        self.result = result
        self.error = nil
    }

    public init(id: String, error: ResponseError) {
        self.id = id
        self.ok = false
        self.result = nil
        self.error = error
    }
}

// MARK: - Operation Names

public enum OpName: String, Codable, CaseIterable, Sendable {
    // System
    case ping
    case daemonStatus
    case daemonStop
    case permissionsStatus
    // Capture
    case captureScreen
    case captureWindow
    case captureArea
    // Element detection
    case detectElements
    // Snapshot
    case getSnapshot
    case listSnapshots
    case cleanSnapshot
    // Actions
    case click
    case type
    case hotkey
    case scroll
    case moveMouse
    case waitForElement
    // Application/Window
    case listApplications
    case listWindows
    case activateApplication
    case focusWindow
    case closeWindow
}

// MARK: - Param / Result types for each op

public struct Bounds: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}

public struct DetectedElement: Codable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let subrole: String?
    public let label: String
    public let title: String?
    public let value: String?
    public let description: String?
    public let identifier: String?
    public let keyboardShortcut: String?
    public let bounds: Bounds
    public let isEnabled: Bool
    public let isActionable: Bool
    public let parentId: String?

    public init(id: String, role: String, subrole: String? = nil, label: String, title: String? = nil, value: String? = nil, description: String? = nil, identifier: String? = nil, keyboardShortcut: String? = nil, bounds: Bounds, isEnabled: Bool, isActionable: Bool, parentId: String? = nil) {
        self.id = id; self.role = role; self.subrole = subrole; self.label = label
        self.title = title; self.value = value; self.description = description
        self.identifier = identifier; self.keyboardShortcut = keyboardShortcut
        self.bounds = bounds; self.isEnabled = isEnabled; self.isActionable = isActionable
        self.parentId = parentId
    }
}

// --- Ping ---
public struct PingParams: Codable, Sendable {}
public struct PingResult: Codable, Sendable {
    public let pong: Bool
    public let timestamp: Int64
    public let daemonVersion: String
}

// --- DaemonStatus ---
public struct DaemonStatusParams: Codable, Sendable {}
public struct DaemonStatusResult: Codable, Sendable {
    public let uptimeMs: Int64
    public let pid: Int32
    public let connectionsActive: Int32
    public let protocolVersion: String
}

// --- DaemonStop ---
public struct DaemonStopParams: Codable, Sendable {}
public struct DaemonStopResult: Codable, Sendable {
    public let stopping: Bool
}

// --- PermissionsStatus ---
public struct PermissionsStatusParams: Codable, Sendable {}
public struct PermissionsStatusResult: Codable, Sendable {
    public let screenRecording: Bool
    public let accessibility: Bool
}

// --- CaptureScreen ---
public struct CaptureScreenParams: Codable, Sendable {
    public let displayIndex: Int?
    public let maxWidth: Int?
    public let annotated: Bool?
}
public struct CaptureResult: Codable, Sendable {
    public let path: String
    public let width: Int
    public let height: Int
    public let displayBounds: Bounds
}

// --- CaptureWindow ---
public struct CaptureWindowParams: Codable, Sendable {
    public let windowId: Int
    public let maxWidth: Int?
}

// --- CaptureArea ---
public struct CaptureAreaParams: Codable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public let maxWidth: Int?
}

// --- DetectElements ---
public struct DetectElementsParams: Codable, Sendable {
    public let windowId: Int?
    public let pid: Int?
    public let allowWebFocus: Bool?
    public let maxDepth: Int?
    public let maxCount: Int?
    /// Detection mode: "auto", "ax_only", "ax_plus_vision", "ax_plus_cdp", "cdp_only", "vision_only".
    /// Defaults to "auto" when nil.
    public let mode: String?
}
public struct DetectElementsResult: Codable, Sendable {
    public let snapshotId: String
    public let screenshotPath: String
    public let annotatedPath: String
    public let elements: [DetectedElement]
    public let applicationName: String?
    public let windowTitle: String?
    public let windowBounds: Bounds?
    public let warnings: [String]
}

// --- GetSnapshot ---
public struct GetSnapshotParams: Codable, Sendable {
    public let snapshotId: String
}

// --- ListSnapshots ---
public struct ListSnapshotsParams: Codable, Sendable {}
public struct SnapshotInfo: Codable, Sendable {
    public let id: String
    public let createdAt: Int64
    public let windowTitle: String?
}
public struct ListSnapshotsResult: Codable, Sendable {
    public let snapshots: [SnapshotInfo]
}

// --- CleanSnapshot ---
public struct CleanSnapshotParams: Codable, Sendable {
    public let snapshotId: String?
}
public struct CleanSnapshotResult: Codable, Sendable {
    public let removed: Int
}

// --- Click ---
public struct ClickParams: Codable, Sendable {
    public let snapshotId: String?
    public let elementId: String?
    public let x: Double?
    public let y: Double?
    public let button: String
    public let clickCount: Int
    public let modifiers: [String]
}
public struct ClickResult: Codable, Sendable {
    public let clickedAt: ClickPoint
    public let targetElement: DetectedElement?
}
public struct ClickPoint: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
}

// --- Type ---
public struct TypeParams: Codable, Sendable {
    public let text: String
    public let clearExisting: Bool?
    public let delayMsPerChar: Int?
    public let snapshotId: String?
    public let elementId: String?
}
public struct TypeResult: Codable, Sendable {
    public let typedChars: Int
}

// --- Hotkey ---
public struct HotkeyParams: Codable, Sendable {
    public let keys: [String]
    public let holdMs: Int?
}
public struct HotkeyResult: Codable, Sendable {
    public let ok: Bool
}

// --- Scroll ---
public struct ScrollParams: Codable, Sendable {
    public let direction: String
    public let amount: Double
    public let x: Double?
    public let y: Double?
}
public struct ScrollResult: Codable, Sendable {
    public let ok: Bool
}

// --- MoveMouse ---
public struct MoveMouseParams: Codable, Sendable {
    public let x: Double
    public let y: Double
}
public struct MoveMouseResult: Codable, Sendable {
    public let ok: Bool
}

// --- WaitForElement ---
public struct ElementQuery: Codable, Sendable {
    public let role: String?
    public let label: String?
    public let identifier: String?
}
public struct WaitForElementParams: Codable, Sendable {
    public let snapshotId: String?
    public let query: ElementQuery
    public let timeoutMs: Int?
}
public struct WaitForElementResult: Codable, Sendable {
    public let found: Bool
    public let element: DetectedElement?
}

// --- ListApplications ---
public struct ListApplicationsParams: Codable, Sendable {}
public struct ApplicationInfo: Codable, Sendable {
    public let pid: Int32
    public let bundleId: String
    public let name: String
    public let isActive: Bool
}
public struct ListApplicationsResult: Codable, Sendable {
    public let applications: [ApplicationInfo]
}

// --- ListWindows ---
public struct ListWindowsParams: Codable, Sendable {
    public let pid: Int?
}
public struct WindowInfo: Codable, Sendable {
    public let windowId: Int
    public let pid: Int32
    public let title: String
    public let bounds: Bounds
    public let isMinimized: Bool
    public let isFrontmost: Bool
}
public struct ListWindowsResult: Codable, Sendable {
    public let windows: [WindowInfo]
}

// --- ActivateApplication ---
public struct ActivateApplicationParams: Codable, Sendable {
    public let pid: Int?
    public let bundleId: String?
}
public struct ActivateApplicationResult: Codable, Sendable {
    public let ok: Bool
}

// --- FocusWindow ---
public struct FocusWindowParams: Codable, Sendable {
    public let windowId: Int
}
public struct FocusWindowResult: Codable, Sendable {
    public let ok: Bool
}

// --- CloseWindow ---
public struct CloseWindowParams: Codable, Sendable {
    public let windowId: Int
}
public struct CloseWindowResult: Codable, Sendable {
    public let ok: Bool
}

// MARK: - Socket path helper

public func defaultSocketPath() -> String {
    let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
    return "\(home)/Library/Application Support/spectrai-claw/claw.sock"
}
