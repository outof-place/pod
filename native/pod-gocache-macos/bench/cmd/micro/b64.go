package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"io"

	"pod-gocache-macos/bench/b64"
)

// onlyReader hides WriterTo so io.Copy uses its 32 KiB buffer, as it does for go's *os.File on darwin.
type onlyReader struct{ io.Reader }

const pipeChunk = 64 << 10 // the most one read(2) returns from a macOS pipe

func b64Benches(raw []byte) []bench {
	n := int64(len(raw))
	enc := make([]byte, base64.StdEncoding.EncodedLen(len(raw)))
	base64.StdEncoding.Encode(enc, raw)
	out := make([]byte, len(raw)+64)
	buf32k := make([]byte, 32<<10)
	buf1m := make([]byte, 1<<20)
	chunked := func(dec decodeFunc) func() map[string]float64 {
		return func() map[string]float64 {
			off := 0
			for i := 0; i < len(enc); i += pipeChunk {
				j := min(i+pipeChunk, len(enc))
				m, err := dec(out[off:], enc[i:j])
				if err != nil {
					fatal("decode: %v", err)
				}
				off += m
			}
			check(out[:off], raw)
			return nil
		}
	}
	return []bench{
		{name: "encode, whole buffer (stdlib Encode)", n: n, run: func() map[string]float64 {
			base64.StdEncoding.Encode(enc, raw)
			return nil
		}},
		{name: "encode as cmd/go streams it (32 KiB reads, NewEncoder, 4 KiB bufio, no pipe)", n: n, run: func() map[string]float64 {
			w := bufio.NewWriterSize(io.Discard, 4096)
			e := base64.NewEncoder(base64.StdEncoding, w)
			io.CopyBuffer(e, onlyReader{bytes.NewReader(raw)}, buf32k)
			e.Close()
			w.Flush()
			return nil
		}},
		{name: "decode, whole buffer, stdlib", n: n, run: func() map[string]float64 {
			m, err := base64.StdEncoding.Decode(out, enc)
			if err != nil {
				fatal("%v", err)
			}
			check(out[:m], raw)
			return nil
		}},
		{name: "decode, whole buffer, NEON (archsimd)", n: n, run: func() map[string]float64 {
			m, err := b64.Decode(out, enc)
			if err != nil {
				fatal("%v", err)
			}
			check(out[:m], raw)
			return nil
		}},
		{name: "decode, 64 KiB chunks (pipe-read sized), stdlib", n: n, run: chunked(base64.StdEncoding.Decode)},
		{name: "decode, 64 KiB chunks (pipe-read sized), NEON", n: n, run: chunked(b64.Decode)},
		{name: "decode via base64.NewDecoder stream, stdlib", n: n, run: func() map[string]float64 {
			d := base64.NewDecoder(base64.StdEncoding, bytes.NewReader(enc))
			for {
				if _, err := d.Read(buf1m); err != nil {
					break
				}
			}
			return nil
		}},
		{name: "SHA-256, 32 KiB reads (cmd/go's OutputID pass)", n: n, run: func() map[string]float64 {
			h := sha256.New()
			io.CopyBuffer(h, onlyReader{bytes.NewReader(raw)}, buf32k)
			h.Sum(nil)
			return nil
		}},
		{name: "scan base64 for the closing quote (dedupe skip)", n: n, run: func() map[string]float64 {
			if bytes.IndexByte(enc, '"') >= 0 {
				fatal("quote in base64")
			}
			return nil
		}},
		{name: "memmove (bandwidth reference)", n: n, run: func() map[string]float64 {
			copy(out, raw)
			return nil
		}},
	}
}

type decodeFunc func(dst, src []byte) (int, error)

// check is sampled so it does not dominate the timed loop; the full comparison runs in b64's tests.
func check(got, want []byte) {
	if len(got) != len(want) {
		fatal("decoded %d bytes, want %d", len(got), len(want))
	}
	for i := 0; i < len(want); i += 1 << 20 {
		if got[i] != want[i] || got[len(got)-1-i] != want[len(want)-1-i] {
			fatal("decoded bytes differ near %d", i)
		}
	}
}
