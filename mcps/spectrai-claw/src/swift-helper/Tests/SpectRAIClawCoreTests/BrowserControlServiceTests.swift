import Darwin
import Foundation
import Testing
@testable import SpectRAIClawCore

private enum MockJSONServerError: Error {
    case socketCreateFailed
    case bindFailed(Int32)
    case listenFailed(Int32)
    case getSockNameFailed(Int32)
}

private final class MockJSONServer: @unchecked Sendable {
    private(set) var port: UInt16 = 0
    private var listenerFD: Int32 = -1
    private var isStopped = false
    private var worker: Task<Void, Never>?

    init(responseBody: String) throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw MockJSONServerError.socketCreateFailed }
        listenerFD = fd

        var yes: Int32 = 1
        _ = withUnsafePointer(to: &yes) { ptr in
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, ptr, socklen_t(MemoryLayout<Int32>.size))
        }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(0).bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindRC = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindRC == 0 else {
            let err = errno
            close(fd)
            throw MockJSONServerError.bindFailed(err)
        }

        guard listen(fd, 4) == 0 else {
            let err = errno
            close(fd)
            throw MockJSONServerError.listenFailed(err)
        }

        var boundAddr = sockaddr_in()
        var boundLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameRC = withUnsafeMutablePointer(to: &boundAddr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &boundLen)
            }
        }
        guard nameRC == 0 else {
            let err = errno
            close(fd)
            throw MockJSONServerError.getSockNameFailed(err)
        }

        port = UInt16(bigEndian: boundAddr.sin_port)

        let response = """
HTTP/1.1 200 OK\r
Content-Type: application/json\r
Connection: close\r
Content-Length: \(responseBody.utf8.count)\r
\r
\(responseBody)
"""

        worker = Task.detached { [fd] in
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientFD = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    accept(fd, $0, &clientLen)
                }
            }
            guard clientFD >= 0 else { return }
            defer { close(clientFD) }

            var buffer = [UInt8](repeating: 0, count: 2048)
            _ = recv(clientFD, &buffer, buffer.count, 0)

            _ = response.utf8CString.withUnsafeBufferPointer { ptr in
                guard let base = ptr.baseAddress else { return -1 }
                return send(clientFD, base, ptr.count - 1, 0)
            }
        }
    }

    func stop() {
        if isStopped { return }
        isStopped = true

        if listenerFD >= 0 {
            shutdown(listenerFD, SHUT_RDWR)
            close(listenerFD)
            listenerFD = -1
        }

        worker?.cancel()
        worker = nil
    }

    deinit {
        stop()
    }
}

@Suite struct BrowserControlServiceTests {
    @Test func detectOpenDebugPortDoesNotThrow() async {
        let port = await BrowserLauncher.detectOpenDebugPort()
        #expect(port == 0 || port == 9222 || port == 9223 || port == 9224)
    }

    @Test func findChromePIDsReturnsArray() {
        let pids = BrowserLauncher.findChromePIDs()
        #expect(pids.allSatisfy { $0 > 0 })
    }

    @Test func listTabsThrowsPortNotOpenWhenNoServer() async {
        let opened = await BrowserControlService.detectDebugPort(pid: 0)
        if opened == 9222 {
            return
        }

        do {
            _ = try await BrowserControlService.listTabs(port: 9222)
            Issue.record("Expected BrowserError.portNotOpen")
        } catch let error as BrowserError {
            switch error {
            case .portNotOpen:
                #expect(Bool(true))
            default:
                Issue.record("Expected .portNotOpen, got \(error)")
            }
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
    }

    @Test func listTabsParsesMockHTTPJson() async throws {
        let payload = """
[
  {
    "id": "tab-1",
    "type": "page",
    "url": "https://example.com",
    "title": "Example",
    "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/page/1"
  },
  {
    "id": "worker-1",
    "type": "worker",
    "url": "https://example.com/worker.js",
    "title": "Worker",
    "webSocketDebuggerUrl": "ws://127.0.0.1/devtools/page/2"
  },
  {
    "id": "tab-2",
    "type": "page",
    "url": "https://example.org",
    "title": "Example Org",
    "webSocketDebuggerUrl": ""
  }
]
"""

        let server = try MockJSONServer(responseBody: payload)
        defer { server.stop() }

        let tabs = try await BrowserControlService.listTabs(port: server.port, host: "127.0.0.1")
        #expect(tabs.count == 1)
        #expect(tabs.first?.tabId == "tab-1")
        #expect(tabs.first?.title == "Example")
        #expect(tabs.first?.webSocketUrl == "ws://127.0.0.1/devtools/page/1")
    }
}
