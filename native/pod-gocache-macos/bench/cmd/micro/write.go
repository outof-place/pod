package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"pod-gocache-macos/bench/b64"
)

// writeBenches lands the body in a new file the way each candidate client would, from base64
// arriving in pipe-read sized chunks. tail_ms is what is left after the last chunk arrives:
// decoding it, finishing the file and renaming it into place (bar b).
func writeBenches(raw []byte, dir string) []bench {
	n := int64(len(raw))
	enc := make([]byte, base64.StdEncoding.EncodedLen(len(raw)))
	base64.StdEncoding.Encode(enc, raw)
	src := filepath.Join(dir, "compile-output.a")
	if err := os.WriteFile(src, raw, 0o644); err != nil {
		fatal("%v", err)
	}
	want := sha256.Sum256(raw)
	final := filepath.Join(dir, "out-d")
	tmp := final + ".tmp"
	clean := func() { os.Remove(final); os.Remove(tmp) }
	verified := map[string]bool{}
	verifyOnce := func(name string) {
		if verified[name] {
			return
		}
		got, err := os.ReadFile(final)
		if err != nil || sha256.Sum256(got) != want {
			fatal("%s: file content differs from the body", name)
		}
		verified[name] = true
	}

	// stream feeds enc in pipe-sized chunks to sink and times the last chunk plus finish.
	stream := func(name string, open func(*os.File) (func([]byte) error, func() error)) bench {
		return bench{name: name, n: n, setup: clean, run: func() map[string]float64 {
			f, err := os.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o666)
			if err != nil {
				fatal("%v", err)
			}
			feed, finish := open(f)
			var lastStart time.Time
			for i := 0; i < len(enc); i += pipeChunk {
				j := min(i+pipeChunk, len(enc))
				if j == len(enc) {
					lastStart = time.Now()
				}
				if err := feed(enc[i:j]); err != nil {
					fatal("%s: %v", name, err)
				}
			}
			if err := finish(); err != nil {
				fatal("%s: %v", name, err)
			}
			if err := os.Rename(tmp, final); err != nil {
				fatal("%v", err)
			}
			tail := time.Since(lastStart)
			verifyOnce(name)
			return map[string]float64{"tail_ms": tail.Seconds() * 1e3}
		}}
	}
	mmapInto := func(dec decodeFunc) func(*os.File) (func([]byte) error, func() error) {
		return func(f *os.File) (func([]byte) error, func() error) {
			if err := syscall.Ftruncate(int(f.Fd()), n); err != nil {
				fatal("%v", err)
			}
			data, err := syscall.Mmap(int(f.Fd()), 0, int(n), syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
			if err != nil {
				fatal("%v", err)
			}
			off := 0
			return func(p []byte) error {
					m, err := dec(data[off:], p)
					off += m
					return err
				}, func() error {
					if err := syscall.Munmap(data); err != nil {
						return err
					}
					return f.Close()
				}
		}
	}
	pwriteBatched := func(dec decodeFunc, batch int) func(*os.File) (func([]byte) error, func() error) {
		return func(f *os.File) (func([]byte) error, func() error) {
			buf := make([]byte, batch+pipeChunk)
			fill := 0
			var off int64
			flush := func() error {
				if fill == 0 {
					return nil
				}
				_, err := f.WriteAt(buf[:fill], off)
				off += int64(fill)
				fill = 0
				return err
			}
			return func(p []byte) error {
					m, err := dec(buf[fill:], p)
					if err != nil {
						return err
					}
					fill += m
					if fill >= batch {
						return flush()
					}
					return nil
				}, func() error {
					if err := flush(); err != nil {
						return err
					}
					return f.Close()
				}
		}
	}
	// wholeThenWrite decodes into a fresh heap buffer as chunks arrive and writes once at the end.
	wholeThenWrite := func(f *os.File) (func([]byte) error, func() error) {
		buf := make([]byte, n+64)
		off := 0
		return func(p []byte) error {
				m, err := b64.Decode(buf[off:], p)
				off += m
				return err
			}, func() error {
				if _, err := f.Write(buf[:off]); err != nil {
					return err
				}
				return f.Close()
			}
	}
	copyOnly := func(useMmap bool) bench {
		name := "no decode: pwrite 1 MiB blocks of ready bytes"
		if useMmap {
			name = "no decode: memcpy ready bytes into an mmap"
		}
		return bench{name: name, n: n, setup: clean, run: func() map[string]float64 {
			f, err := os.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o666)
			if err != nil {
				fatal("%v", err)
			}
			if useMmap {
				syscall.Ftruncate(int(f.Fd()), n)
				data, err := syscall.Mmap(int(f.Fd()), 0, int(n), syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
				if err != nil {
					fatal("%v", err)
				}
				copy(data, raw)
				syscall.Munmap(data)
			} else {
				for off := 0; off < len(raw); off += 1 << 20 {
					f.WriteAt(raw[off:min(off+1<<20, len(raw))], int64(off))
				}
			}
			f.Close()
			os.Rename(tmp, final)
			verifyOnce(name)
			return nil
		}}
	}
	return []bench{
		stream("mmap, NEON decode straight into the mapping", mmapInto(b64.Decode)),
		stream("mmap, stdlib decode straight into the mapping", mmapInto(base64.StdEncoding.Decode)),
		stream("pwrite each 48 KiB decoded chunk, NEON", pwriteBatched(b64.Decode, 1)),
		stream("pwrite each 48 KiB decoded chunk, stdlib", pwriteBatched(base64.StdEncoding.Decode, 1)),
		stream("pwrite 1 MiB batches, NEON", pwriteBatched(b64.Decode, 1<<20)),
		stream("decode all into a fresh heap buffer, one write at the end, NEON", wholeThenWrite),
		copyOnly(true),
		copyOnly(false),
		builtinPut("built-in cache put (cmd/go DiskCache.put: SHA-256 pass, copyFile with SHA-256 tee)", src, final, n, false),
		builtinPut("built-in cache put when the output already exists (re-hash, no write)", src, final, n, true),
	}
}

// builtinPut repeats what cmd/go/internal/cache DiskCache.put does for a new or existing output.
func builtinPut(name, src, final string, n int64, exists bool) bench {
	setup := func() { os.Remove(final) }
	if exists {
		setup = func() {
			if st, err := os.Stat(final); err != nil || st.Size() != n {
				b, _ := os.ReadFile(src)
				os.WriteFile(final, b, 0o666)
			}
		}
	}
	return bench{name: name, n: n, setup: setup, run: func() map[string]float64 {
		f, err := os.Open(src)
		if err != nil {
			fatal("%v", err)
		}
		defer f.Close()
		h := sha256.New()
		size, _ := io.Copy(h, f)
		out := h.Sum(nil)
		f.Seek(0, 0)
		if st, err := os.Stat(final); err == nil && st.Size() == size {
			g, _ := os.Open(final)
			h2 := sha256.New()
			io.Copy(h2, g)
			g.Close()
			if bytes.Equal(h2.Sum(nil), out) {
				return nil
			}
		}
		d, err := os.OpenFile(final, os.O_RDWR|os.O_CREATE, 0o666)
		if err != nil {
			fatal("%v", err)
		}
		h3 := sha256.New()
		if _, err := io.CopyN(io.MultiWriter(d, h3), f, size-1); err != nil {
			fatal("%v", err)
		}
		last := make([]byte, 1)
		f.Read(last)
		h3.Write(last)
		if !bytes.Equal(h3.Sum(nil), out) {
			fatal("content changed underfoot")
		}
		d.Write(last)
		if err := d.Close(); err != nil {
			fatal("%v", err)
		}
		entry := fmt.Sprintf("v1 %x %x %20d %20d\n", out, out, size, time.Now().UnixNano())
		os.WriteFile(final+"-a", []byte(entry), 0o666)
		return nil
	}}
}
