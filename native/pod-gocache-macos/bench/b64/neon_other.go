//go:build !(goexperiment.simd && arm64)

package b64

const simdEnabled = false

func decodeBlocks(dst, src []byte) (n, si int) { return 0, 0 }
