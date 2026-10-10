import Foundation
import AppKit
import ApplicationServices

private func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

private func rectPayload(_ rect: CGRect) -> [String: Double]? {
    guard [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite && abs($0) < 200000 }),
          rect.width >= 0, rect.height > 0 else { return nil }
    return ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
}

private func focusedAnchor(_ pid: pid_t) -> (CGRect, String)? {
    guard AXIsProcessTrusted() else { return nil }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.12)
    guard let value = axAttribute(application, kAXFocusedUIElementAttribute),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    let focused = value as! AXUIElement
    AXUIElementSetMessagingTimeout(focused, 0.12)
    if axAttribute(focused, kAXSubroleAttribute) as? String == "AXSecureTextField" { return nil }

    // Query geometry only: never read the field value or selected text.
    if let selection = axAttribute(focused, kAXSelectedTextRangeAttribute),
       CFGetTypeID(selection) == AXValueGetTypeID() {
        let rangeValue = selection as! AXValue
        var range = CFRange()
        if AXValueGetType(rangeValue) == .cfRange, AXValueGetValue(rangeValue, .cfRange, &range) {
            range = CFRange(location: range.location + range.length, length: 0)
            if let caret = AXValueCreate(.cfRange, &range) {
                var bounds: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(focused, kAXBoundsForRangeParameterizedAttribute as CFString,
                    caret, &bounds) == .success, let bounds, CFGetTypeID(bounds) == AXValueGetTypeID() {
                    let rectValue = bounds as! AXValue
                    var rect = CGRect.zero
                    if AXValueGetType(rectValue) == .cgRect, AXValueGetValue(rectValue, .cgRect, &rect),
                       rectPayload(rect) != nil { return (rect, "caret") }
                }
            }
        }
    }
    guard let role = axAttribute(focused, kAXRoleAttribute) as? String,
          [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role),
          let position = axAttribute(focused, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = axAttribute(focused, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    var extent = CGSize.zero
    let positionValue = position as! AXValue
    let sizeValue = size as! AXValue
    guard AXValueGetType(positionValue) == .cgPoint, AXValueGetValue(positionValue, .cgPoint, &origin),
          AXValueGetType(sizeValue) == .cgSize, AXValueGetValue(sizeValue, .cgSize, &extent) else { return nil }
    let rect = CGRect(origin: origin, size: extent)
    return rectPayload(rect) == nil ? nil : (rect, "input")
}

@MainActor func printInputContext() {
    guard let application = NSWorkspace.shared.frontmostApplication else { return }
    let pid = application.processIdentifier
    var context: [String: Any] = ["type": "input-context", "target": String(pid), "coordinateSpace": "dip",
        "rect": NSNull(), "source": NSNull()]
    func emit() {
        guard let data = try? JSONSerialization.data(withJSONObject: context) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    emit()
    if let (rect, source) = focusedAnchor(pid), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
        context["rect"] = rectPayload(rect)
        context["source"] = source
    }
    emit()
}
