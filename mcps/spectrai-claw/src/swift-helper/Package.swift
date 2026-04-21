// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "spectrai-claw-helper",
    // Upgraded from .v13 to .v14: AXorcist (v0.1.0) declares platforms: [.macOS(.v14)].
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "spectrai-claw-helper",
            targets: ["SpectRAIClaw"]
        ),
        .library(
            name: "SpectRAIClawCore",
            targets: ["SpectRAIClawCore"]
        )
    ],
    dependencies: [
        // AXorcist v0.1.0 (2026-01-18) — stable tag, MIT license.
        // Provides Swift-friendly AXUIElement wrappers, eliminating raw AXUIElementCopyAttributeValue boilerplate.
        .package(url: "https://github.com/steipete/AXorcist.git", from: "0.1.0")
    ],
    targets: [
        .target(
            name: "SpectRAIClawCore",
            dependencies: [
                .product(name: "AXorcist", package: "AXorcist")
            ],
            path: "Sources/SpectRAIClawCore"
        ),
        .executableTarget(
            name: "SpectRAIClaw",
            dependencies: [
                "SpectRAIClawCore"
            ],
            path: "Sources/SpectRAIClaw",
            linkerSettings: [
                .linkedFramework("CoreGraphics"),
                .linkedFramework("AppKit"),
                .linkedFramework("Vision"),
                .linkedFramework("ApplicationServices"),
            ]
        ),
        .testTarget(
            name: "SpectRAIClawCoreTests",
            dependencies: ["SpectRAIClawCore"],
            path: "Tests/SpectRAIClawCoreTests",
            // Testing.framework lives outside the standard SDK search path on CLT-only machines.
            // These flags are a workaround; full Xcode.app removes the need for them.
            swiftSettings: [
                .unsafeFlags([
                    "-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"
                ])
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-framework", "Testing",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/usr/lib"
                ])
            ]
        )
    ]
)
