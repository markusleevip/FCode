import AppKit
import ApplicationServices

func pointerTarget(_ target: JSONObject) -> JSONObject {
    var result: JSONObject = [:]
    for field in ["appId", "pid", "instanceId", "windowId"] { if let value = target[field] { result[field] = value } }
    return result
}

func previewFrameGeometry(_ target: JSONObject, region: CGRect, topology: String, width: Int, height: Int) -> JSONObject {
    return ["target": pointerTarget(target), "region": regionJSON(region),
            "topologyVersion": topology, "width": width, "height": height]
}

/** Query geometry only, never page values or text. Missing/ambiguous geometry hides the display marker. */
func chromeContentRegion(_ target: JSONObject) -> CGRect? {
    guard let window = try? uniqueAXWindow(target), let bounds = try? windowRegion(target) else { return nil }
    let deadline = monotonicNow() + 0.3
    var queue = [window]
    var index = 0
    var regions: [CGRect] = []
    while index < queue.count {
        guard index < 128, monotonicNow() < deadline else { return nil }
        let element = queue[index]
        index += 1
        AXUIElementSetMessagingTimeout(element, 0.025)
        if axValue(element, kAXRoleAttribute) as? String == "AXWebArea" {
            guard let rect = axRegion(element), rect.width > 0, rect.height > 0,
                  [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite }), bounds.contains(rect) else { return nil }
            regions.append(rect)
            // Embedded frames do not define the top-level page viewport.
            continue
        }
        var count = 0
        guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success else { continue }
        if count == 0 { continue }
        guard count <= 128 - queue.count else { return nil }
        var children: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, count, &children) == .success,
              let values = children as? [AXUIElement] else { return nil }
        queue.append(contentsOf: values)
    }
    return regions.count == 1 ? regions[0] : nil
}
