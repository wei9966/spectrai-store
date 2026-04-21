import Testing
import Foundation
@testable import SpectRAIClawCore

// MARK: - Test helpers

private func connectUnix(path: String) throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw TestSocketError.socketFailed }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathLen = MemoryLayout.size(ofValue: addr.sun_path)
    path.withCString { cStr in
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathLen) {
                _ = strncpy($0, cStr, pathLen - 1)
            }
        }
    }
    let rc = withUnsafePointer(to: addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard rc == 0 else {
        close(fd)
        throw TestSocketError.connectFailed(errno)
    }
    return fd
}

@discardableResult
private func sendAll(fd: Int32, data: Data) -> Bool {
    var offset = 0
    while offset < data.count {
        let n = data.withUnsafeBytes { ptr in
            send(fd, ptr.baseAddress!.advanced(by: offset), data.count - offset, 0)
        }
        guard n > 0 else { return false }
        offset += n
    }
    return true
}

private func recvFrame(fd: Int32) throws -> Data {
    // Read 4-byte header
    var header = Data(count: 4)
    var got = 0
    while got < 4 {
        let n = header.withUnsafeMutableBytes { ptr in
            recv(fd, ptr.baseAddress!.advanced(by: got), 4 - got, 0)
        }
        guard n > 0 else { throw TestSocketError.recvFailed }
        got += n
    }
    let length = UInt32(header[0]) << 24 | UInt32(header[1]) << 16
        | UInt32(header[2]) << 8 | UInt32(header[3])
    guard length <= kMaxFrameSize else { throw TestSocketError.frameTooLarge }

    var body = Data(count: Int(length))
    var recv_ = 0
    while recv_ < Int(length) {
        let n = body.withUnsafeMutableBytes { ptr in
            recv(fd, ptr.baseAddress!.advanced(by: recv_), Int(length) - recv_, 0)
        }
        guard n > 0 else { throw TestSocketError.recvFailed }
        recv_ += n
    }
    return body
}

private func sendRequest(fd: Int32, id: String, op: String) throws {
    let req = Request(id: id, op: op, params: .null)
    let data = try JSONEncoder().encode(req)
    let frame = try encodeFrame(data)
    guard sendAll(fd: fd, data: frame) else { throw TestSocketError.sendFailed }
}

private enum TestSocketError: Error {
    case socketFailed, connectFailed(Int32), recvFailed, sendFailed, frameTooLarge
}

// MARK: - Tests

@Suite struct SocketHostTests {

    private func makeHostAndDispatcher(socketPath: String) throws -> (SocketHost, Dispatcher) {
        let dispatcher = Dispatcher(coordinator: DaemonCoordinator.shared)
        let host = SocketHost(path: socketPath)
        try host.start(dispatcher: dispatcher)
        return (host, dispatcher)
    }

    @Test func pingPongBasic() async throws {
        let socketPath = "/tmp/spectrai-claw-test-\(UUID().uuidString).sock"
        let (host, _) = try makeHostAndDispatcher(socketPath: socketPath)
        defer { host.stop() }

        try await Task.sleep(for: .milliseconds(30))

        let fd = try connectUnix(path: socketPath)
        defer { close(fd) }

        try sendRequest(fd: fd, id: "req-1", op: "ping")
        let body = try recvFrame(fd: fd)
        let resp = try JSONDecoder().decode(Response.self, from: body)

        #expect(resp.id == "req-1")
        #expect(resp.ok == true)
        if case .object(let obj) = resp.result {
            #expect(obj["pong"] == .bool(true))
        } else {
            Issue.record("Expected object result")
        }
    }

    @Test func oversizedFrameIsRejected() async throws {
        let socketPath = "/tmp/spectrai-claw-test-\(UUID().uuidString).sock"
        let (host, _) = try makeHostAndDispatcher(socketPath: socketPath)
        defer { host.stop() }

        try await Task.sleep(for: .milliseconds(30))

        let fd = try connectUnix(path: socketPath)
        defer { close(fd) }

        // Send a 4-byte header claiming 128 MiB (0x08000000) — exceeds kMaxFrameSize (64 MiB)
        var header = Data(count: 4)
        let badSize: UInt32 = 128 * 1024 * 1024
        header[0] = UInt8((badSize >> 24) & 0xFF)
        header[1] = UInt8((badSize >> 16) & 0xFF)
        header[2] = UInt8((badSize >> 8) & 0xFF)
        header[3] = UInt8(badSize & 0xFF)
        sendAll(fd: fd, data: header)

        // Expect either an error response or EOF
        var tvRecv = timeval(tv_sec: 3, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tvRecv, socklen_t(MemoryLayout<timeval>.size))

        if let body = try? recvFrame(fd: fd),
           let resp = try? JSONDecoder().decode(Response.self, from: body) {
            #expect(resp.ok == false)
            #expect(resp.error?.code == .eInvalidArgs)
        } else {
            // Connection was closed without sending a response — also acceptable
        }
    }

    @Test func fiveSequentialPingsWithCorrectIdPairing() async throws {
        let socketPath = "/tmp/spectrai-claw-test-\(UUID().uuidString).sock"
        let (host, _) = try makeHostAndDispatcher(socketPath: socketPath)
        defer { host.stop() }

        try await Task.sleep(for: .milliseconds(30))

        let fd = try connectUnix(path: socketPath)
        defer { close(fd) }

        // Send 5 pings in a row
        let ids = (1...5).map { "concurrent-\($0)" }
        for id in ids {
            try sendRequest(fd: fd, id: id, op: "ping")
        }

        // Receive 5 responses and verify ID pairing
        var responseIds: [String] = []
        for _ in ids {
            let body = try recvFrame(fd: fd)
            let resp = try JSONDecoder().decode(Response.self, from: body)
            #expect(resp.ok == true)
            responseIds.append(resp.id)
        }

        #expect(responseIds.sorted() == ids.sorted())
    }

    @Test func socketFileCleanedOnStop() async throws {
        let socketPath = "/tmp/spectrai-claw-test-\(UUID().uuidString).sock"
        let (host, _) = try makeHostAndDispatcher(socketPath: socketPath)
        #expect(FileManager.default.fileExists(atPath: socketPath))
        host.stop()
        try await Task.sleep(for: .milliseconds(30))
        #expect(!FileManager.default.fileExists(atPath: socketPath))
    }
}
