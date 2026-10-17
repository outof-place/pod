// Package b64 is the S0 prototype of a NEON base64 decoder built on simd/archsimd.
// Decode must stay byte-for-byte equal to base64.StdEncoding.Decode (n, error and dst[:n]).
package b64

import "encoding/base64"

// Decode is base64.StdEncoding.Decode with a SIMD fast path for runs of pure alphabet text.
func Decode(dst, src []byte) (int, error) {
	n, si := decodeBlocks(dst, src)
	m, err := base64.StdEncoding.Decode(dst[n:], src[si:])
	if cie, ok := err.(base64.CorruptInputError); ok {
		err = cie + base64.CorruptInputError(si)
	}
	return n + m, err
}

// SIMD reports whether this build decodes with the archsimd NEON path.
func SIMD() bool { return simdEnabled }
