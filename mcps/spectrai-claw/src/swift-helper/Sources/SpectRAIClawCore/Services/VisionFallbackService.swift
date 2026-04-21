import CoreGraphics
import Foundation
import Vision

public struct VisionDetectedElement: Codable, Sendable {
    public let id: String
    public let role: String
    public let label: String
    public let bounds: Bounds
    public let confidence: Float
    public let source: String

    public init(id: String, role: String, label: String, bounds: Bounds, confidence: Float, source: String) {
        self.id = id; self.role = role; self.label = label
        self.bounds = bounds; self.confidence = confidence; self.source = source
    }
}

public enum VisionFallbackError: Error, Sendable {
    case imageNotFound(String)
    case imageLoadFailed(String)
}

public enum VisionFallbackService {

    public static func detect(
        imagePath: String,
        captureOrigin: CGPoint,
        captureSize: CGSize,
        existingBounds: [CGRect] = [],
        languages: [String] = ["zh-Hans", "en-US"],
        maxElements: Int = 200
    ) async throws -> [VisionDetectedElement] {
        guard FileManager.default.fileExists(atPath: imagePath) else {
            throw VisionFallbackError.imageNotFound("Image not found: \(imagePath)")
        }
        guard let dataProvider = CGDataProvider(filename: imagePath),
              let cgImage = CGImage(
                  pngDataProviderSource: dataProvider,
                  decode: nil, shouldInterpolate: false,
                  intent: .defaultIntent)
        else {
            throw VisionFallbackError.imageLoadFailed("Could not load PNG: \(imagePath)")
        }

        let imgW = CGFloat(cgImage.width)
        let imgH = CGFloat(cgImage.height)

        async let ocrResults = runOCR(cgImage: cgImage, languages: languages)
        async let rectResults = runRectangleDetection(cgImage: cgImage)

        let ocrObs = (try? await ocrResults) ?? []
        let rectObs = (try? await rectResults) ?? []

        var elements: [VisionDetectedElement] = []
        var index = 1

        struct TextHit {
            let text: String
            let confidence: Float
            let screenBounds: CGRect
        }

        var textHits: [TextHit] = []
        for obs in ocrObs {
            guard let candidate = obs.topCandidates(1).first else { continue }
            let bb = obs.boundingBox
            let screenRect = normalizedToScreen(bb, imgW: imgW, imgH: imgH,
                                                origin: captureOrigin, size: captureSize)
            textHits.append(TextHit(text: candidate.string,
                                    confidence: candidate.confidence,
                                    screenBounds: screenRect))
            let b = Bounds(x: Double(screenRect.origin.x), y: Double(screenRect.origin.y),
                           width: Double(screenRect.width), height: Double(screenRect.height))
            elements.append(VisionDetectedElement(
                id: "vis_\(index)", role: "AXVisionText", label: candidate.string,
                bounds: b, confidence: candidate.confidence, source: "ocr"))
            index += 1
        }

        var consumedTextIndices: Set<Int> = []
        for rectObs in rectObs {
            let bb = rectBoundingBox(rectObs)
            let screenRect = normalizedToScreen(bb, imgW: imgW, imgH: imgH,
                                                origin: captureOrigin, size: captureSize)
            var containedTexts: [(Int, TextHit)] = []
            for (i, hit) in textHits.enumerated() {
                if screenRect.contains(hit.screenBounds) {
                    containedTexts.append((i, hit))
                }
            }
            let label: String
            let conf: Float
            if containedTexts.isEmpty {
                label = "region"
                conf = Float(rectObs.confidence)
            } else {
                label = containedTexts.map(\.1.text).joined(separator: " ")
                conf = containedTexts.map(\.1.confidence).reduce(0, +) / Float(containedTexts.count)
                for (i, _) in containedTexts { consumedTextIndices.insert(i) }
            }
            let role = containedTexts.isEmpty ? "AXVisionRegion" : "AXVisionButton"
            let b = Bounds(x: Double(screenRect.origin.x), y: Double(screenRect.origin.y),
                           width: Double(screenRect.width), height: Double(screenRect.height))
            elements.append(VisionDetectedElement(
                id: "vis_\(index)", role: role, label: label,
                bounds: b, confidence: conf, source: "rectangle"))
            index += 1
        }

        elements = elements.enumerated().compactMap { (i, el) -> VisionDetectedElement? in
            if el.source == "ocr", consumedTextIndices.contains(i) { return nil }
            return el
        }

        if !existingBounds.isEmpty {
            elements = elements.filter { el in
                let elRect = CGRect(x: el.bounds.x, y: el.bounds.y,
                                    width: el.bounds.width, height: el.bounds.height)
                return !existingBounds.contains { iou(elRect, $0) >= 0.5 }
            }
        }

        elements.sort { $0.confidence > $1.confidence }
        if elements.count > maxElements {
            elements = Array(elements.prefix(maxElements))
        }

        var finalIndex = 1
        elements = elements.map { el in
            let newId = "vis_\(finalIndex)"
            finalIndex += 1
            return VisionDetectedElement(id: newId, role: el.role, label: el.label,
                                         bounds: el.bounds, confidence: el.confidence, source: el.source)
        }

        return elements
    }

    // MARK: - Vision Requests

    private static func runOCR(
        cgImage: CGImage, languages: [String]
    ) async throws -> [VNRecognizedTextObservation] {
        try await withCheckedThrowingContinuation { cont in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                let results = (request.results as? [VNRecognizedTextObservation]) ?? []
                cont.resume(returning: results)
            }
            request.recognitionLevel = .accurate
            request.recognitionLanguages = languages
            request.usesLanguageCorrection = true
            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            do {
                try handler.perform([request])
            } catch {
                cont.resume(throwing: error)
            }
        }
    }

    private static func runRectangleDetection(
        cgImage: CGImage
    ) async throws -> [VNRectangleObservation] {
        try await withCheckedThrowingContinuation { cont in
            let request = VNDetectRectanglesRequest { request, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                let results = (request.results as? [VNRectangleObservation]) ?? []
                cont.resume(returning: results)
            }
            request.minimumAspectRatio = 0.3
            request.maximumAspectRatio = 10.0
            request.minimumSize = 0.02
            request.maximumObservations = 80
            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            do {
                try handler.perform([request])
            } catch {
                cont.resume(throwing: error)
            }
        }
    }

    // MARK: - Coordinate Conversion

    private static func normalizedToScreen(
        _ bb: CGRect, imgW: CGFloat, imgH: CGFloat,
        origin: CGPoint, size: CGSize
    ) -> CGRect {
        let scaleX = size.width / imgW
        let scaleY = size.height / imgH
        let x = origin.x + bb.minX * imgW * scaleX
        let y = origin.y + (1.0 - bb.maxY) * imgH * scaleY
        let w = bb.width * imgW * scaleX
        let h = bb.height * imgH * scaleY
        return CGRect(x: x, y: y, width: w, height: h)
    }

    private static func rectBoundingBox(_ obs: VNRectangleObservation) -> CGRect {
        let points = [obs.topLeft, obs.topRight, obs.bottomLeft, obs.bottomRight]
        let xs = points.map(\.x)
        let ys = points.map(\.y)
        let minX = xs.min()!
        let maxX = xs.max()!
        let minY = ys.min()!
        let maxY = ys.max()!
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    // MARK: - IoU

    private static func iou(_ a: CGRect, _ b: CGRect) -> Double {
        let intersection = a.intersection(b)
        if intersection.isNull || intersection.isEmpty { return 0 }
        let interArea = Double(intersection.width * intersection.height)
        let unionArea = Double(a.width * a.height) + Double(b.width * b.height) - interArea
        return unionArea > 0 ? interArea / unionArea : 0
    }
}
