// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "spectrai-claw-helper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "spectrai-claw-helper",
            targets: ["SpectRAIClaw"]
        )
    ],
    targets: [
        .executableTarget(
            name: "SpectRAIClaw",
            path: "Sources/SpectRAIClaw",
            linkerSettings: [
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AppKit"),
                .linkedFramework("Vision"),
                .linkedFramework("ApplicationServices"),
            ]
        )
    ]
)
