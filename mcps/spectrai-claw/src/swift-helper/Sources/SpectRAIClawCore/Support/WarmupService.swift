import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

public final class WarmupService: @unchecked Sendable {
    public static let shared = WarmupService()

    private enum State {
        case idle
        case running
        case completed
    }

    private let stateQueue = DispatchQueue(label: "spectrai.claw.warmup")
    private var state: State = .idle

    private init() {}

    public var isPending: Bool {
        stateQueue.sync {
            if case .running = state {
                return true
            }
            return false
        }
    }

    public func startIfNeeded() {
        let shouldStart = stateQueue.sync { () -> Bool in
            guard case .idle = state else { return false }
            state = .running
            return true
        }
        guard shouldStart else { return }

        Task.detached(priority: .utility) {
            await self.warmupSubsystems()
        }
    }

    private func warmupSubsystems() async {
        defer { markCompleted() }

        await warmupScreenCapture()
        warmupAccessibility()
        warmupVision()
    }

    private func markCompleted() {
        stateQueue.sync {
            state = .completed
        }
    }

    private func warmupScreenCapture() async {
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                log("screen capture warmup skipped: no displays found")
                return
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = false
            config.width = 1
            config.height = 1
            config.sourceRect = CGRect(x: 0, y: 0, width: 1, height: 1)

            _ = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            log("screen capture warmup failed: \(error.localizedDescription)")
        }
    }

    private func warmupAccessibility() {
        let systemWide = AXUIElementCreateSystemWide()
        var roleValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(systemWide, kAXRoleAttribute as CFString, &roleValue)
        if result != .success && result != .attributeUnsupported && result != .noValue {
            log("accessibility warmup failed: AX error \(result.rawValue)")
        }
    }

    private func warmupVision() {
        guard let cgImage = makeWarmupImage() else {
            log("vision warmup skipped: failed to create 1x1 image")
            return
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        if (try? handler.perform([request])) == nil {
            log("vision warmup failed")
        }
    }

    private func makeWarmupImage() -> CGImage? {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }

        context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        return context.makeImage()
    }

    private func log(_ message: String) {
        guard let data = "[spectrai-claw warmup] \(message)\n".data(using: .utf8) else { return }
        FileHandle.standardError.write(data)
    }
}
