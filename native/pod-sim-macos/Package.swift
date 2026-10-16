// swift-tools-version: 6.0

import PackageDescription

// pod-sim: the only Pod process that loads CoreSimulator and SimulatorKit (private, resolved at run
// time; nothing here links them). Pod's runtime drives it over stdio; see README.md.
let package = Package(
    name: "PodSimMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "PodSimKit", targets: ["PodSimKit"]),
        .executable(name: "pod-sim", targets: ["PodSim"])
    ],
    targets: [
        .target(
            name: "CPodSimObjC",
            path: "Sources/CPodSimObjC"
        ),
        .target(
            name: "PodSimKit",
            dependencies: ["CPodSimObjC"],
            path: "Sources/PodSimKit"
        ),
        .executableTarget(
            name: "PodSim",
            dependencies: ["PodSimKit"],
            path: "Sources/PodSim"
        ),
        .testTarget(
            name: "PodSimKitTests",
            dependencies: ["PodSimKit"],
            path: "Tests/PodSimKitTests"
        )
    ]
)
