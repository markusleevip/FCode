import Foundation
import CoreGraphics

struct WindowCaptureGeometry {
    let width: Int
    let height: Int
    let displayIndex: Int?
    let sourceRect: CGRect?

    var destinationRect: CGRect { CGRect(x: 0, y: 0, width: width, height: height) }

    static func make(region: CGRect, displays: [CGRect], onScreen: Bool,
                     displayFilteringAvailable: Bool, previewOnly: Bool) throws -> WindowCaptureGeometry {
        guard valid(region), displays.allSatisfy(valid) else {
            throw ControlFailure("capture_failed", "The window capture geometry is invalid.")
        }
        let limit: CGFloat = previewOnly ? 1000 : 1600
        let scale = min(2, limit / max(region.width, region.height))
        let width = max(1, Int((region.width * scale).rounded()))
        let height = max(1, Int((region.height * scale).rounded()))
        let matches = displays.indices.filter { displays[$0].contains(region) }
        let displayIndex = onScreen && displayFilteringAvailable && matches.count == 1 ? matches[0] : nil
        let sourceRect = displayIndex.map { index in
            CGRect(x: region.minX - displays[index].minX, y: region.minY - displays[index].minY,
                   width: region.width, height: region.height)
        }
        return WindowCaptureGeometry(width: width, height: height,
                                     displayIndex: displayIndex, sourceRect: sourceRect)
    }

    private static func valid(_ rect: CGRect) -> Bool {
        [rect.origin.x, rect.origin.y, rect.size.width, rect.size.height, rect.maxX, rect.maxY].allSatisfy { $0.isFinite } &&
            rect.size.width > 0 && rect.size.height > 0
    }
}
