import AppKit
import Foundation

public enum AnnotatedScreenshotError: Error, Sendable {
    case loadFailed(String)
    case renderFailed(String)
}

public enum AnnotatedScreenshot {
    public static func render(
        sourcePath: String,
        elements: [DetectedElement],
        displayBounds: CGRect,
        outputPath: String? = nil
    ) throws -> String {
        guard let sourceImage = NSImage(contentsOfFile: sourcePath) else {
            throw AnnotatedScreenshotError.loadFailed("Cannot load image: \(sourcePath)")
        }

        guard let tiffData = sourceImage.tiffRepresentation,
              let bitmapRep = NSBitmapImageRep(data: tiffData) else {
            throw AnnotatedScreenshotError.loadFailed("Cannot create bitmap from: \(sourcePath)")
        }

        let imgWidth = CGFloat(bitmapRep.pixelsWide)
        let imgHeight = CGFloat(bitmapRep.pixelsHigh)

        let scaleX = imgWidth / max(displayBounds.width, 1)
        let scaleY = imgHeight / max(displayBounds.height, 1)

        let image = NSImage(size: NSSize(width: imgWidth, height: imgHeight))
        image.lockFocus()

        sourceImage.draw(in: NSRect(x: 0, y: 0, width: imgWidth, height: imgHeight))

        for element in elements {
            let elRect = CGRect(
                x: (element.bounds.x - displayBounds.origin.x) * scaleX,
                y: (element.bounds.y - displayBounds.origin.y) * scaleY,
                width: element.bounds.width * scaleX,
                height: element.bounds.height * scaleY
            )

            let flippedY = imgHeight - elRect.origin.y - elRect.height
            let drawRect = NSRect(x: elRect.origin.x, y: flippedY, width: elRect.width, height: elRect.height)

            let strokeColor = colorForRole(element.role)
            strokeColor.setStroke()
            let path = NSBezierPath(rect: drawRect)
            path.lineWidth = 1.5
            path.stroke()

            let label = "[\(element.id)]"
            let font = NSFont.boldSystemFont(ofSize: 8)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: NSColor.white,
            ]
            let labelSize = label.size(withAttributes: attrs)
            let padding: CGFloat = 2

            var labelOrigin = NSPoint(
                x: drawRect.origin.x,
                y: drawRect.origin.y + drawRect.height + 1
            )

            if labelOrigin.y + labelSize.height + padding * 2 > imgHeight {
                labelOrigin.y = drawRect.origin.y - labelSize.height - padding * 2 - 1
            }
            if labelOrigin.x + labelSize.width + padding * 2 > imgWidth {
                labelOrigin.x = imgWidth - labelSize.width - padding * 2
            }

            let bgRect = NSRect(
                x: labelOrigin.x,
                y: labelOrigin.y,
                width: labelSize.width + padding * 2,
                height: labelSize.height + padding * 2
            )
            NSColor(white: 0, alpha: 0.7).setFill()
            NSBezierPath(roundedRect: bgRect, xRadius: 2, yRadius: 2).fill()

            label.draw(at: NSPoint(x: labelOrigin.x + padding, y: labelOrigin.y + padding), withAttributes: attrs)
        }

        image.unlockFocus()

        guard let finalTiff = image.tiffRepresentation,
              let finalBitmap = NSBitmapImageRep(data: finalTiff),
              let pngData = finalBitmap.representation(using: .png, properties: [:]) else {
            throw AnnotatedScreenshotError.renderFailed("Failed to encode annotated PNG")
        }

        let outPath = outputPath ?? sourcePath.replacingOccurrences(of: ".png", with: ".annotated.png")
        try pngData.write(to: URL(fileURLWithPath: outPath))
        return outPath
    }

    private static func colorForRole(_ role: String) -> NSColor {
        switch role {
        case "AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem":
            return NSColor(red: 0, green: 0.47, blue: 1, alpha: 1) // #0078FF
        case "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox":
            return NSColor(red: 0.2, green: 0.78, blue: 0.35, alpha: 1) // #34C759
        default:
            return NSColor(white: 0.7, alpha: 1)
        }
    }
}
