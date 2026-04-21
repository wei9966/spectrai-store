import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

public enum ScreenCaptureError: Error, Sendable {
    case permissionDenied(String)
    case invalidArgs(String)
    case captureFailed(String)
}

public enum ScreenCaptureService {
    public struct CaptureResult: Sendable {
        public let path: String
        public let width: Int
        public let height: Int
        public let displayBounds: CGRect
    }

    public static func captureScreen(displayIndex: Int = 0, maxWidth: Int? = nil, outputPath: String? = nil) async throws -> CaptureResult {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw ScreenCaptureError.permissionDenied("Screen recording permission not granted: \(error.localizedDescription)")
        }

        guard !content.displays.isEmpty else {
            throw ScreenCaptureError.captureFailed("No displays found")
        }
        guard displayIndex >= 0 && displayIndex < content.displays.count else {
            throw ScreenCaptureError.invalidArgs("displayIndex \(displayIndex) out of range (0..<\(content.displays.count))")
        }

        let display = content.displays[displayIndex]
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = makeConfig(display: display, maxWidth: maxWidth)

        let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let outPath = outputPath ?? defaultOutputPath()
        try writePNG(cgImage, to: outPath)

        return CaptureResult(
            path: outPath,
            width: cgImage.width,
            height: cgImage.height,
            displayBounds: CGRect(x: CGFloat(display.frame.origin.x), y: CGFloat(display.frame.origin.y),
                                  width: CGFloat(display.frame.width), height: CGFloat(display.frame.height))
        )
    }

    public static func captureWindow(windowId: CGWindowID, maxWidth: Int? = nil, outputPath: String? = nil) async throws -> CaptureResult {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw ScreenCaptureError.permissionDenied("Screen recording permission not granted: \(error.localizedDescription)")
        }

        guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
            throw ScreenCaptureError.invalidArgs("Window \(windowId) not found")
        }

        guard let display = content.displays.first else {
            throw ScreenCaptureError.captureFailed("No displays found")
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false

        if let mw = maxWidth {
            let aspect = CGFloat(window.frame.height) / max(CGFloat(window.frame.width), 1)
            config.width = mw
            config.height = Int(CGFloat(mw) * aspect)
        } else {
            config.width = Int(window.frame.width) * 2
            config.height = Int(window.frame.height) * 2
        }

        let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let outPath = outputPath ?? defaultOutputPath()
        try writePNG(cgImage, to: outPath)

        return CaptureResult(
            path: outPath,
            width: cgImage.width,
            height: cgImage.height,
            displayBounds: CGRect(x: CGFloat(display.frame.origin.x), y: CGFloat(display.frame.origin.y),
                                  width: CGFloat(display.frame.width), height: CGFloat(display.frame.height))
        )
    }

    public static func captureArea(_ rect: CGRect, maxWidth: Int? = nil, outputPath: String? = nil) async throws -> CaptureResult {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw ScreenCaptureError.permissionDenied("Screen recording permission not granted: \(error.localizedDescription)")
        }

        guard let display = content.displays.first(where: { $0.frame.intersects(rect) }) ?? content.displays.first else {
            throw ScreenCaptureError.captureFailed("No displays found")
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false
        config.sourceRect = CGRect(
            x: rect.origin.x - display.frame.origin.x,
            y: rect.origin.y - display.frame.origin.y,
            width: rect.width,
            height: rect.height
        )

        if let mw = maxWidth {
            let aspect = rect.height / max(rect.width, 1)
            config.width = mw
            config.height = Int(CGFloat(mw) * aspect)
        } else {
            config.width = Int(rect.width) * 2
            config.height = Int(rect.height) * 2
        }

        let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let outPath = outputPath ?? defaultOutputPath()
        try writePNG(cgImage, to: outPath)

        return CaptureResult(
            path: outPath,
            width: cgImage.width,
            height: cgImage.height,
            displayBounds: CGRect(x: CGFloat(display.frame.origin.x), y: CGFloat(display.frame.origin.y),
                                  width: CGFloat(display.frame.width), height: CGFloat(display.frame.height))
        )
    }

    // MARK: - Private

    private static func makeConfig(display: SCDisplay, maxWidth: Int?) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false

        if let mw = maxWidth {
            let aspect = CGFloat(display.frame.height) / max(CGFloat(display.frame.width), 1)
            config.width = mw
            config.height = Int(CGFloat(mw) * aspect)
        } else {
            config.width = Int(display.frame.width) * 2
            config.height = Int(display.frame.height) * 2
        }
        return config
    }

    private static func defaultOutputPath() -> String {
        let epochMs = Int(Date().timeIntervalSince1970 * 1000)
        return "/tmp/spectrai_ss_\(epochMs).png"
    }

    private static func writePNG(_ image: CGImage, to path: String) throws {
        let bitmapRep = NSBitmapImageRep(cgImage: image)
        guard let pngData = bitmapRep.representation(using: .png, properties: [:]) else {
            throw ScreenCaptureError.captureFailed("Failed to encode PNG")
        }
        let url = URL(fileURLWithPath: path)
        try pngData.write(to: url)
    }
}
