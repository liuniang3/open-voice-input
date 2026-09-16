// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "audio-capture-helper",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "audio-capture-helper", targets: ["AudioCaptureHelper"])],
    targets: [.executableTarget(name: "AudioCaptureHelper", path: "Sources",
        linkerSettings: [.linkedFramework("AVFoundation"), .linkedFramework("ScreenCaptureKit"),
            .linkedFramework("CoreMedia"), .linkedFramework("CoreAudio"),
            .linkedFramework("AppKit"), .linkedFramework("ApplicationServices")])],
    swiftLanguageVersions: [.v5]
)
