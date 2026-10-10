// swift-tools-version: 6.2

import PackageDescription

// AccKit: claude-acc's state ($STATE = ~/.local/share/claude-acc) as Swift models, an observable
// store and its commands. No UI: Pod's native shell and Pod Menu.app (claude-acc's menu helper)
// draw their own views over the same data. AccKitTesting: fixtures for their tests and previews.
let package = Package(
    name: "AccKit",
    platforms: [
        .macOS(.v26)
    ],
    products: [
        .library(name: "AccKit", targets: ["AccKit"]),
        .library(name: "AccKitTesting", targets: ["AccKitTesting"]),
    ],
    targets: [
        .target(name: "AccKit", path: "Sources/AccKit"),
        .target(
            name: "AccKitTesting", dependencies: ["AccKit"], path: "Sources/AccKitTesting",
            resources: [.copy("Fixtures")]),
        .testTarget(name: "AccKitTests", dependencies: ["AccKit", "AccKitTesting"], path: "Tests/AccKitTests"),
    ]
)
