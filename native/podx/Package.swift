// swift-tools-version: 6.0

import PackageDescription

// Native `podx`/`orca` front: no Foundation, so an exec costs about what a C binary does.
let package = Package(
    name: "PodX",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "podx", targets: ["podx"])
    ],
    targets: [
        .target(
            name: "PodxCore",
            path: "Sources/PodxCore"
        ),
        .executableTarget(
            name: "podx",
            dependencies: ["PodxCore"],
            path: "Sources/podx",
            // Why: autolinked but unused dylibs (Foundation) still cost dyld time on every exec.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-dead_strip_dylibs"])]
        ),
        .testTarget(
            name: "PodxCoreTests",
            dependencies: ["PodxCore"],
            path: "Tests/PodxCoreTests"
        )
    ]
)
