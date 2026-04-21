import AppKit
import CoreGraphics
import Foundation
import Testing
@testable import SpectRAIClawCore

@Suite struct VisionFallbackServiceTests {

    private func createTestImage() throws -> String {
        let width = 400
        let height = 300
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw VisionFallbackError.imageLoadFailed("Cannot create CGContext")
        }

        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

        ctx.setStrokeColor(CGColor(red: 0.3, green: 0.3, blue: 0.3, alpha: 1))
        ctx.setLineWidth(2)
        ctx.stroke(CGRect(x: 30, y: 30, width: 160, height: 50))

        let attrString = NSAttributedString(
            string: "Hello World",
            attributes: [
                .font: NSFont.systemFont(ofSize: 28, weight: .bold),
                .foregroundColor: NSColor.black,
            ])
        let line = CTLineCreateWithAttributedString(attrString)
        ctx.textPosition = CGPoint(x: 50, y: height - 70)
        CTLineDraw(line, ctx)

        let cnAttr = NSAttributedString(
            string: "点击我",
            attributes: [
                .font: NSFont.systemFont(ofSize: 24, weight: .medium),
                .foregroundColor: NSColor.black,
            ])
        let cnLine = CTLineCreateWithAttributedString(cnAttr)
        ctx.textPosition = CGPoint(x: 50, y: height - 160)
        CTLineDraw(cnLine, ctx)

        guard let cgImage = ctx.makeImage() else {
            throw VisionFallbackError.imageLoadFailed("Cannot make CGImage")
        }

        let path = NSTemporaryDirectory() + "vision_test_\(ProcessInfo.processInfo.processIdentifier).png"
        let url = URL(fileURLWithPath: path)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            throw VisionFallbackError.imageLoadFailed("Cannot create image destination")
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        CGImageDestinationFinalize(dest)
        return path
    }

    @Test func detectFindsTextElements() async throws {
        let imgPath = try createTestImage()
        defer { try? FileManager.default.removeItem(atPath: imgPath) }

        let elements = try await VisionFallbackService.detect(
            imagePath: imgPath,
            captureOrigin: .zero,
            captureSize: CGSize(width: 400, height: 300)
        )

        #expect(elements.count >= 1)
        let allLabels = elements.map(\.label).joined(separator: " ")
        let hasExpectedText = allLabels.contains("Hello") || allLabels.contains("World") || allLabels.contains("点击")
        #expect(hasExpectedText, "Expected OCR to find 'Hello', 'World' or '点击' in: \(allLabels)")

        for el in elements {
            #expect(el.id.hasPrefix("vis_"))
            #expect(el.bounds.width > 0)
            #expect(el.bounds.height > 0)
        }
    }

    @Test func existingBoundsDeduplication() async throws {
        let imgPath = try createTestImage()
        defer { try? FileManager.default.removeItem(atPath: imgPath) }

        let allElements = try await VisionFallbackService.detect(
            imagePath: imgPath,
            captureOrigin: .zero,
            captureSize: CGSize(width: 400, height: 300)
        )
        guard let first = allElements.first else { return }

        let overlap = CGRect(x: first.bounds.x, y: first.bounds.y,
                             width: first.bounds.width, height: first.bounds.height)
        let filtered = try await VisionFallbackService.detect(
            imagePath: imgPath,
            captureOrigin: .zero,
            captureSize: CGSize(width: 400, height: 300),
            existingBounds: [overlap]
        )

        #expect(filtered.count < allElements.count,
                "Passing existingBounds should deduplicate: \(filtered.count) vs \(allElements.count)")
    }

    @Test func throwsForMissingImage() async {
        do {
            _ = try await VisionFallbackService.detect(
                imagePath: "/nonexistent/fake.png",
                captureOrigin: .zero,
                captureSize: CGSize(width: 100, height: 100)
            )
            Issue.record("Expected error for missing image")
        } catch let err as VisionFallbackError {
            switch err {
            case .imageNotFound(let msg):
                #expect(msg.contains("fake.png"))
            default:
                Issue.record("Expected imageNotFound, got: \(err)")
            }
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
    }

    @Test func idsAreSequential() async throws {
        let imgPath = try createTestImage()
        defer { try? FileManager.default.removeItem(atPath: imgPath) }

        let elements = try await VisionFallbackService.detect(
            imagePath: imgPath,
            captureOrigin: .zero,
            captureSize: CGSize(width: 400, height: 300)
        )
        for (i, el) in elements.enumerated() {
            #expect(el.id == "vis_\(i + 1)")
        }
    }

    @Test func maxElementsCap() async throws {
        let imgPath = try createTestImage()
        defer { try? FileManager.default.removeItem(atPath: imgPath) }

        let elements = try await VisionFallbackService.detect(
            imagePath: imgPath,
            captureOrigin: .zero,
            captureSize: CGSize(width: 400, height: 300),
            maxElements: 1
        )
        #expect(elements.count <= 1)
    }
}
