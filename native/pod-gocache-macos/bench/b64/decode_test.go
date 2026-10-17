package b64

import (
	"bytes"
	"encoding/base64"
	"math/rand/v2"
	"os"
	"strings"
	"testing"
)

// same fails when Decode and the stdlib disagree on n, the error, or the written bytes.
func same(t *testing.T, name string, src []byte) {
	t.Helper()
	want := make([]byte, base64.StdEncoding.DecodedLen(len(src)))
	got := make([]byte, len(want))
	wn, werr := base64.StdEncoding.Decode(want, src)
	gn, gerr := Decode(got, src)
	if wn != gn || (werr == nil) != (gerr == nil) || (werr != nil && werr.Error() != gerr.Error()) {
		t.Fatalf("%s: len(src)=%d: stdlib n=%d err=%v, Decode n=%d err=%v", name, len(src), wn, werr, gn, gerr)
	}
	if !bytes.Equal(want[:wn], got[:gn]) {
		t.Fatalf("%s: len(src)=%d: bytes differ", name, len(src))
	}
}

func randBytes(r *rand.Rand, n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(r.Uint32())
	}
	return b
}

func TestFastPathIsActiveWithExperiment(t *testing.T) {
	if !strings.Contains(os.Getenv("GOEXPERIMENT"), "simd") {
		t.Skip("GOEXPERIMENT=simd not set; scalar build")
	}
	src := []byte(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xa5}, 96)))
	dst := make([]byte, 96)
	if n, si := decodeBlocks(dst, src); n == 0 || si == 0 {
		t.Fatalf("SIMD path decoded nothing (n=%d si=%d); simdEnabled=%v", n, si, simdEnabled)
	}
}

func TestLengths0To300(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for n := 0; n <= 300; n++ {
		for rep := 0; rep < 8; rep++ {
			raw := randBytes(r, n)
			same(t, "valid", []byte(base64.StdEncoding.EncodeToString(raw)))
		}
	}
}

func TestEveryByteAtEveryPosition(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	enc := []byte(base64.StdEncoding.EncodeToString(randBytes(r, 96))) // 128 chars, no padding
	for pos := range enc {
		for b := 0; b < 256; b++ {
			src := bytes.Clone(enc)
			src[pos] = byte(b)
			same(t, "byte", src)
		}
	}
}

func TestPaddingVariants(t *testing.T) {
	r := rand.New(rand.NewPCG(5, 6))
	prefix := base64.StdEncoding.EncodeToString(randBytes(r, 120)) // 160 chars
	tails := []string{
		"", "Q", "QQ", "QQ=", "QQ==", "QQ===", "QUI", "QUI=", "QUI==", "QUJD", "QUJD=",
		"QR==", "QUJ=", "=", "==", "====", "QQ==QUJD", "QUI=QUJD", "Q===", "QQ=A", "QQ=\n=",
	}
	for _, tail := range tails {
		same(t, "tail "+tail, []byte(prefix+tail))
		same(t, "alone "+tail, []byte(tail))
		same(t, "mid "+tail, []byte(prefix[:64]+tail+prefix[64:]))
	}
}

func TestNewlinesAndQuotes(t *testing.T) {
	r := rand.New(rand.NewPCG(7, 8))
	enc := base64.StdEncoding.EncodeToString(randBytes(r, 3000))
	for _, ins := range []string{"\n", "\r", "\r\n", "\"", " ", "\x00", "\xff"} {
		for _, pos := range []int{0, 1, 15, 16, 63, 64, 65, 100, 2000, len(enc) - 1, len(enc)} {
			same(t, "insert", []byte(enc[:pos]+ins+enc[pos:]))
		}
	}
}

func TestShortDst(t *testing.T) {
	r := rand.New(rand.NewPCG(9, 10))
	raw := randBytes(r, 1000)
	src := []byte(base64.StdEncoding.EncodeToString(raw))
	// Exactly sized dst: the fast path must never touch bytes past len(dst).
	dst := make([]byte, len(raw), len(raw)+64)
	guard := dst[len(raw):cap(dst)]
	for i := range guard {
		guard[i] = 0xee
	}
	n, err := Decode(dst, src)
	if err != nil || n != len(raw) || !bytes.Equal(dst, raw) {
		t.Fatalf("n=%d err=%v equal=%v", n, err, bytes.Equal(dst[:n], raw))
	}
	for i, b := range guard {
		if b != 0xee {
			t.Fatalf("wrote past len(dst) at +%d", i)
		}
	}
}

func Test254MB(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	r := rand.New(rand.NewPCG(11, 12))
	raw := make([]byte, 254<<20)
	for i := 0; i+8 <= len(raw); i += 8 {
		v := r.Uint64()
		for j := 0; j < 8; j++ {
			raw[i+j] = byte(v >> (8 * j))
		}
	}
	raw = raw[:len(raw)-1] // odd length: one '=' of padding
	src := make([]byte, base64.StdEncoding.EncodedLen(len(raw)))
	base64.StdEncoding.Encode(src, raw)
	dst := make([]byte, base64.StdEncoding.DecodedLen(len(src)))
	n, err := Decode(dst, src)
	if err != nil || n != len(raw) || !bytes.Equal(dst[:n], raw) {
		t.Fatalf("n=%d want %d err=%v equal=%v", n, len(raw), err, bytes.Equal(dst[:n], raw))
	}
}

func FuzzDecode(f *testing.F) {
	f.Add([]byte("QUJD"))
	f.Add([]byte(strings.Repeat("QUJD", 40) + "QQ=="))
	f.Add([]byte(strings.Repeat("a/+9", 33) + "\n"))
	f.Fuzz(func(t *testing.T, data []byte) {
		same(t, "raw", data)
		same(t, "encoded", []byte(base64.StdEncoding.EncodeToString(data)))
	})
}
