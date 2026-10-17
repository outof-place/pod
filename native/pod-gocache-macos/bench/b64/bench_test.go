package b64

import (
	"encoding/base64"
	"math/rand/v2"
	"testing"
)

// Quick in-cache sanity benchmarks (1 MiB); cmd/micro has the 254 MB numbers with spread.
func benchInput() (raw, enc []byte) {
	r := rand.New(rand.NewPCG(13, 14))
	raw = randBytes(r, 1<<20)
	enc = []byte(base64.StdEncoding.EncodeToString(raw))
	return raw, enc
}

func BenchmarkDecodeStdlib(b *testing.B) {
	raw, enc := benchInput()
	dst := make([]byte, len(raw))
	b.SetBytes(int64(len(raw)))
	for b.Loop() {
		base64.StdEncoding.Decode(dst, enc)
	}
}

func BenchmarkDecodeB64(b *testing.B) {
	raw, enc := benchInput()
	dst := make([]byte, len(raw))
	b.SetBytes(int64(len(raw)))
	for b.Loop() {
		Decode(dst, enc)
	}
}

func BenchmarkEncodeStdlib(b *testing.B) {
	raw, enc := benchInput()
	b.SetBytes(int64(len(raw)))
	for b.Loop() {
		base64.StdEncoding.Encode(enc, raw)
	}
}
