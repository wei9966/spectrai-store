import AppKit
import CoreGraphics
import Foundation

public struct CDPDetectedElement: Codable, Sendable {
    public let id: String // "cdp_N"
    public let role: String
    public let tagName: String
    public let label: String
    public let attributes: [String: String]
    public let bounds: CGRect
    public let isVisible: Bool

    public init(
        id: String,
        role: String,
        tagName: String,
        label: String,
        attributes: [String: String],
        bounds: CGRect,
        isVisible: Bool
    ) {
        self.id = id
        self.role = role
        self.tagName = tagName
        self.label = label
        self.attributes = attributes
        self.bounds = bounds
        self.isVisible = isVisible
    }
}

public struct BrowserTabInfo: Codable, Sendable {
    public let tabId: String
    public let url: String
    public let title: String
    public let webSocketUrl: String

    public init(tabId: String, url: String, title: String, webSocketUrl: String) {
        self.tabId = tabId
        self.url = url
        self.title = title
        self.webSocketUrl = webSocketUrl
    }
}

public enum BrowserError: Error, Sendable {
    case portNotOpen
    case noTabFound
    case connectionFailed(String)
    case cdpCommandFailed(String)
    case timeout
}

public enum BrowserControlService {
    private static let candidatePorts: [UInt16] = [9222, 9223, 9224]
    private static let defaultHost = "127.0.0.1"

    public static func detectDebugPort(pid: pid_t) async -> UInt16 {
        _ = pid // 暂按端口探测认定，不做 pid 精确匹配
        for port in candidatePorts {
            if await isDebugPortOpen(host: defaultHost, port: port) {
                return port
            }
        }
        return 0
    }

    public static func listTabs(port: UInt16 = 9222, host: String = "127.0.0.1") async throws -> [BrowserTabInfo] {
        guard let url = URL(string: "http://\(host):\(port)/json") else {
            throw BrowserError.connectionFailed("Invalid /json URL")
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 2.0

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw mapHTTPError(error, host: host, port: port)
        }

        guard let http = response as? HTTPURLResponse else {
            throw BrowserError.connectionFailed("Invalid HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BrowserError.cdpCommandFailed("/json returned status \(http.statusCode)")
        }

        let tabs: [CDPTabPayload]
        do {
            tabs = try JSONDecoder().decode([CDPTabPayload].self, from: data)
        } catch {
            throw BrowserError.cdpCommandFailed("Failed to decode /json payload: \(error.localizedDescription)")
        }

        return tabs
            .filter { $0.type == "page" }
            .compactMap { tab in
                guard let ws = tab.webSocketDebuggerUrl, !ws.isEmpty else { return nil }
                return BrowserTabInfo(
                    tabId: tab.id,
                    url: tab.url,
                    title: tab.title,
                    webSocketUrl: ws
                )
            }
    }

    public static func detectElements(
        webSocketUrl: String,
        windowOrigin: CGPoint = .zero,
        maxElements: Int = 500
    ) async throws -> [CDPDetectedElement] {
        guard maxElements > 0 else { return [] }
        guard let url = URL(string: webSocketUrl) else {
            throw BrowserError.connectionFailed("Invalid WebSocket URL: \(webSocketUrl)")
        }

        let task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        defer { task.cancel(with: .goingAway, reason: nil) }

        let expression = detectElementsExpression(maxElements: maxElements)
        let response = try await withTimeout(seconds: 3.0) {
            try await sendCDPCommand(
                task: task,
                id: 1,
                method: "Runtime.evaluate",
                params: [
                    "expression": expression,
                    "returnByValue": true,
                ]
            )
        }

        let rawJSONString = try extractRuntimeValueAsString(from: response)
        let jsonData = Data(rawJSONString.utf8)

        let raw: [RawDetectedElement]
        do {
            raw = try JSONDecoder().decode([RawDetectedElement].self, from: jsonData)
        } catch {
            throw BrowserError.cdpCommandFailed("Failed to decode detected elements: \(error.localizedDescription)")
        }

        return raw.prefix(maxElements).map { item in
            let rect = CGRect(
                x: windowOrigin.x + item.bounds.x,
                y: windowOrigin.y + item.bounds.y,
                width: item.bounds.w,
                height: item.bounds.h
            )
            return CDPDetectedElement(
                id: item.id,
                role: item.role,
                tagName: item.tagName,
                label: item.label,
                attributes: item.attrs,
                bounds: rect,
                isVisible: item.isVisible
            )
        }
    }

    public static func clickByCDPId(webSocketUrl: String, cdpId: String) async throws {
        _ = webSocketUrl
        _ = cdpId
        throw BrowserError.cdpCommandFailed("TODO: clickByCDPId is not implemented yet. Use element center + ClickService.")
    }

    public static func typeByCDPId(webSocketUrl: String, cdpId: String, text: String) async throws {
        _ = webSocketUrl
        _ = cdpId
        _ = text
        throw BrowserError.cdpCommandFailed("TODO: typeByCDPId is not implemented yet.")
    }

    // MARK: - Internal payloads

    private struct CDPTabPayload: Decodable {
        let id: String
        let type: String
        let url: String
        let title: String
        let webSocketDebuggerUrl: String?
    }

    private struct RawDetectedElement: Decodable {
        let id: String
        let role: String
        let tagName: String
        let label: String
        let attrs: [String: String]
        let bounds: RawBounds
        let isVisible: Bool
    }

    private struct RawBounds: Decodable {
        let x: Double
        let y: Double
        let w: Double
        let h: Double
    }

    // MARK: - Helpers

    private static func isDebugPortOpen(host: String, port: UInt16) async -> Bool {
        guard let url = URL(string: "http://\(host):\(port)/json/version") else {
            return false
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 1.0

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return false
            }
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return false
            }
            guard let ws = obj["webSocketDebuggerUrl"] as? String, !ws.isEmpty else {
                return false
            }
            return true
        } catch {
            return false
        }
    }

    private static func mapHTTPError(_ error: Error, host: String, port: UInt16) -> BrowserError {
        if let e = error as? URLError {
            switch e.code {
            case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .dnsLookupFailed,
                 .timedOut, .notConnectedToInternet:
                return .portNotOpen
            default:
                return .connectionFailed("HTTP request to \(host):\(port) failed: \(e.localizedDescription)")
            }
        }
        return .connectionFailed("HTTP request to \(host):\(port) failed: \(error.localizedDescription)")
    }

    private static func sendCDPCommand(
        task: URLSessionWebSocketTask,
        id: Int,
        method: String,
        params: [String: Any]
    ) async throws -> [String: Any] {
        let command: [String: Any] = [
            "id": id,
            "method": method,
            "params": params,
        ]

        let commandData: Data
        do {
            commandData = try JSONSerialization.data(withJSONObject: command)
        } catch {
            throw BrowserError.cdpCommandFailed("Failed to serialize CDP command: \(error.localizedDescription)")
        }

        guard let jsonString = String(data: commandData, encoding: .utf8) else {
            throw BrowserError.cdpCommandFailed("Failed to encode CDP command as UTF-8")
        }

        do {
            try await task.send(.string(jsonString))
        } catch {
            throw BrowserError.connectionFailed("WebSocket send failed: \(error.localizedDescription)")
        }

        while true {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                throw BrowserError.connectionFailed("WebSocket receive failed: \(error.localizedDescription)")
            }

            let payload: Data
            switch message {
            case .string(let text):
                payload = Data(text.utf8)
            case .data(let data):
                payload = data
            @unknown default:
                continue
            }

            guard let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
                continue
            }

            guard let responseId = json["id"] as? Int, responseId == id else {
                continue
            }

            if let err = json["error"] as? [String: Any] {
                let message = (err["message"] as? String) ?? "Unknown CDP error"
                throw BrowserError.cdpCommandFailed(message)
            }

            return json
        }
    }

    private static func extractRuntimeValueAsString(from response: [String: Any]) throws -> String {
        guard let result = response["result"] as? [String: Any] else {
            throw BrowserError.cdpCommandFailed("CDP response missing result")
        }

        if let exception = result["exceptionDetails"] as? [String: Any] {
            let text = (exception["text"] as? String) ?? "Runtime.evaluate exception"
            throw BrowserError.cdpCommandFailed(text)
        }

        guard let runtimeResult = result["result"] as? [String: Any] else {
            throw BrowserError.cdpCommandFailed("Runtime.evaluate missing nested result")
        }

        if let value = runtimeResult["value"] as? String {
            return value
        }

        if let value = runtimeResult["value"], JSONSerialization.isValidJSONObject(value) {
            let data = try JSONSerialization.data(withJSONObject: value)
            if let text = String(data: data, encoding: .utf8) {
                return text
            }
        }

        if let text = runtimeResult["description"] as? String {
            return text
        }

        throw BrowserError.cdpCommandFailed("Runtime.evaluate returned no string value")
    }

    private static func detectElementsExpression(maxElements: Int) -> String {
        let template = #"""
(() => {
  const out = [];
  let idx = 0;
  const maxCount = __MAX_ELEMENTS__;
  const selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [onclick]';
  document.querySelectorAll(selector).forEach(el => {
    if (idx >= maxCount) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const id = 'cdp_' + (++idx);
    el.setAttribute('data-spectrai-id', id);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 80);
    const tag = el.tagName.toLowerCase();
    const role = ({a:'AXLink', button:'AXButton', input:'AXTextField', select:'AXPopUpButton', textarea:'AXTextArea'}[tag]) || ('AX' + (el.getAttribute('role') || 'Group'));
    out.push({
      id,
      role,
      tagName: tag,
      label,
      attrs: {
        id: el.id || '',
        class: el.className || '',
        type: el.type || '',
        href: el.href || ''
      },
      bounds: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      isVisible: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth
    });
  });
  return JSON.stringify(out);
})()
"""#
        return template.replacingOccurrences(of: "__MAX_ELEMENTS__", with: "\(maxElements)")
    }

    private static func withTimeout<T>(
        seconds: TimeInterval,
        operation: @escaping () async throws -> T
    ) async throws -> T {
        let timeoutNs = UInt64(max(0, seconds) * 1_000_000_000)

        return try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                try await operation()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNs)
                throw BrowserError.timeout
            }

            guard let first = try await group.next() else {
                throw BrowserError.timeout
            }
            group.cancelAll()
            return first
        }
    }
}
