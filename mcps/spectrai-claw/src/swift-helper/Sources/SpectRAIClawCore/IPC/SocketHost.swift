import Foundation
import Darwin

// TODO: extract to Protocol.swift if shared with TS
private func ensureParentDirectory(for path: String) throws {
    let dir = URL(fileURLWithPath: path).deletingLastPathComponent()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
}

// MARK: - SocketHost

public final class SocketHost: @unchecked Sendable {
    public let path: String

    private var serverFd: Int32 = -1
    private let acceptQueue = DispatchQueue(label: "spectrai.claw.sockethost.accept")
    private var acceptSource: DispatchSourceRead?

    // Set by DaemonCoordinator before calling start()
    var onConnectionAccepted: (() -> Void)?
    var onConnectionClosed: (() -> Void)?

    public init(path: String) {
        self.path = path
    }

    /// Bind the Unix socket, start accepting. Returns immediately; connections are handled in background Tasks.
    public func start(dispatcher: Dispatcher) throws {
        try ensureParentDirectory(for: path)

        // Remove stale socket file
        Darwin.unlink(path)

        // Create Unix domain socket
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw posixError("socket") }
        serverFd = fd

        // Bind
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < pathLen else {
            Darwin.close(fd)
            throw SocketHostError.pathTooLong
        }
        path.withCString { cStr in
            withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
                ptr.withMemoryRebound(to: CChar.self, capacity: pathLen) {
                    _ = Darwin.strncpy($0, cStr, pathLen - 1)
                }
            }
        }
        let bindRc = withUnsafePointer(to: addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindRc == 0 else {
            Darwin.close(fd)
            throw posixError("bind")
        }

        // Restrict to owner only
        Darwin.chmod(path, 0o600)

        // Listen
        guard Darwin.listen(fd, 10) == 0 else {
            Darwin.close(fd)
            throw posixError("listen")
        }

        // DispatchSource accept loop
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: acceptQueue)
        source.setEventHandler { [weak self] in
            self?.acceptOne(dispatcher: dispatcher)
        }
        source.setCancelHandler { [fd] in Darwin.close(fd) }
        source.resume()
        acceptSource = source
    }

    public func stop() {
        acceptSource?.cancel()
        acceptSource = nil
        Darwin.unlink(path)
    }

    // MARK: - Accept

    private func acceptOne(dispatcher: Dispatcher) {
        var clientAddr = sockaddr_un()
        var addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
        let clientFd = withUnsafeMutablePointer(to: &clientAddr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.accept(serverFd, $0, &addrLen)
            }
        }
        guard clientFd >= 0 else { return }

        // Same-UID check
        var peerUid: uid_t = 0
        var peerGid: gid_t = 0
        guard Darwin.getpeereid(clientFd, &peerUid, &peerGid) == 0, peerUid == Darwin.getuid() else {
            Darwin.close(clientFd)
            return
        }

        onConnectionAccepted?()
        let onClose = onConnectionClosed

        Task.detached(priority: .medium) {
            await ConnectionHandler(fd: clientFd, dispatcher: dispatcher).run()
            onClose?()
        }
    }
}

// MARK: - ConnectionHandler

private final class ConnectionHandler: @unchecked Sendable {
    private let fd: Int32
    private let dispatcher: Dispatcher

    init(fd: Int32, dispatcher: Dispatcher) {
        self.fd = fd
        self.dispatcher = dispatcher
    }

    func run() async {
        defer { Darwin.close(fd) }

        // 10s read timeout
        var tv = timeval(tv_sec: 10, tv_usec: 0)
        Darwin.setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var buf = Data()

        outer: while true {
            // Try to decode all complete frames already in the buffer
            while true {
                do {
                    guard let (body, rest) = try decodeFrame(buf) else { break }
                    buf = rest
                    let keep = await handleBody(body)
                    if !keep { break outer }
                } catch FrameError.messageTooLarge(let size) {
                    await sendError(id: "?", code: .eInvalidArgs,
                                    message: "Frame too large: \(size) bytes (max \(kMaxFrameSize))")
                    break outer
                } catch {
                    break outer
                }
            }

            // Need more bytes
            var tmp = [UInt8](repeating: 0, count: 65_536)
            let n = Darwin.recv(fd, &tmp, tmp.count, 0)
            if n <= 0 { break }
            buf.append(contentsOf: tmp[0..<n])
        }
    }

    private func handleBody(_ body: Data) async -> Bool {
        let request: Request
        do {
            request = try JSONDecoder().decode(Request.self, from: body)
        } catch {
            await sendError(id: "?", code: .eInvalidArgs, message: "Invalid JSON request")
            return false
        }

        let response = await dispatcher.handle(request)

        do {
            let data = try JSONEncoder().encode(response)
            let frame = try encodeFrame(data)
            return sendAll(frame)
        } catch {
            return false
        }
    }

    private func sendError(id: String, code: ErrorCode, message: String) async {
        let resp = Response(id: id, error: ResponseError(code: code, message: message))
        guard let data = try? JSONEncoder().encode(resp),
              let frame = try? encodeFrame(data) else { return }
        _ = sendAll(frame)
    }

    @discardableResult
    private func sendAll(_ data: Data) -> Bool {
        var offset = 0
        while offset < data.count {
            let n = data.withUnsafeBytes { ptr in
                Darwin.send(fd, ptr.baseAddress!.advanced(by: offset), data.count - offset, 0)
            }
            guard n > 0 else { return false }
            offset += n
        }
        return true
    }
}

// MARK: - Errors

private enum SocketHostError: Error {
    case pathTooLong
}

private func posixError(_ op: String) -> Error {
    NSError(domain: NSPOSIXErrorDomain, code: Int(errno),
            userInfo: [NSLocalizedDescriptionKey: "\(op): \(String(cString: Darwin.strerror(errno)))"])
}
