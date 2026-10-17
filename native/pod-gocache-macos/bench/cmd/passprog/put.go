package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"syscall"
	"time"

	"pod-gocache-macos/bench/b64"
	"pod-gocache-macos/bench/internal/nativecache"
	"pod-gocache-macos/bench/internal/proglog"
)

// inbuf is one growable buffer over stdin shared by request lines and streamed bodies.
type inbuf struct {
	f        *os.File
	buf      []byte
	r, w     int
	reads    int
	lastRead int64
}

func (b *inbuf) fill() error {
	if b.r > 0 {
		copy(b.buf, b.buf[b.r:b.w])
		b.w -= b.r
		b.r = 0
	}
	if b.w == len(b.buf) {
		nb := make([]byte, 2*len(b.buf))
		copy(nb, b.buf[:b.w])
		b.buf = nb
	}
	n, err := b.f.Read(b.buf[b.w:])
	b.lastRead = time.Now().UnixNano()
	b.reads++
	b.w += n
	if n > 0 {
		return nil
	}
	if err == nil {
		err = io.ErrUnexpectedEOF
	}
	return err
}

func (b *inbuf) line() ([]byte, error) {
	for {
		if i := bytes.IndexByte(b.buf[b.r:b.w], '\n'); i >= 0 {
			l := b.buf[b.r : b.r+i]
			b.r += i + 1
			return l, nil
		}
		if err := b.fill(); err != nil {
			return nil, err
		}
	}
}

type decodeFunc func(dst, src []byte) (int, error)

// sink receives the body in whole base64 quanta; only the last piece may carry padding.
type sink interface {
	decode(p []byte) error
	finish() (written int64, err error)
}

type discardSink struct{}

func (discardSink) decode([]byte) error    { return nil }
func (discardSink) finish() (int64, error) { return 0, nil }

type pwriteSink struct {
	f       *os.File
	dec     decodeFunc
	scratch []byte
	off     int64
}

func (s *pwriteSink) decode(p []byte) error {
	need := base64.StdEncoding.DecodedLen(len(p))
	if cap(s.scratch) < need {
		s.scratch = make([]byte, need)
	}
	n, err := s.dec(s.scratch[:need], p)
	if err != nil {
		return err
	}
	if _, err := s.f.WriteAt(s.scratch[:n], s.off); err != nil {
		return err
	}
	s.off += int64(n)
	return nil
}

func (s *pwriteSink) finish() (int64, error) { return s.off, s.f.Close() }

type mmapSink struct {
	f    *os.File
	dec  decodeFunc
	data []byte
	off  int
}

func newMmapSink(f *os.File, size int64, dec decodeFunc) (*mmapSink, error) {
	if err := syscall.Ftruncate(int(f.Fd()), size); err != nil {
		return nil, err
	}
	data, err := syscall.Mmap(int(f.Fd()), 0, int(size), syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		return nil, err
	}
	return &mmapSink{f: f, dec: dec, data: data}, nil
}

func (s *mmapSink) decode(p []byte) error {
	n, err := s.dec(s.data[s.off:], p)
	s.off += n
	return err
}

func (s *mmapSink) finish() (int64, error) {
	err := syscall.Munmap(s.data)
	if cerr := s.f.Close(); err == nil {
		err = cerr
	}
	return int64(s.off), err
}

func (c *client) decodeFunc() decodeFunc {
	if c.decoder == "stdlib" {
		return base64.StdEncoding.Decode
	}
	return b64.Decode
}

// putReq stores the body under OutputID (temp file, then rename) and then writes the -a entry,
// so a reader never finds an entry whose output is still being written.
func (c *client) putReq(req *request, ev *proglog.Event) (*response, error) {
	ev.Action = fmt.Sprintf("%x", req.ActionID)
	ev.Output = fmt.Sprintf("%x", req.OutputID)
	ev.Size = req.BodySize
	if len(req.ActionID) != nativecache.HashSize || len(req.OutputID) != nativecache.HashSize {
		return nil, fmt.Errorf("put %d: bad ids", req.ID)
	}
	final := nativecache.FileName(c.dir, req.OutputID, "d")
	tmp := fmt.Sprintf("%s.tmp.%d.%d", final, os.Getpid(), req.ID)

	var s sink = discardSink{}
	var setupErr error
	if c.put == "dedupe" {
		if st, err := os.Stat(final); err == nil && st.Mode().IsRegular() && st.Size() == req.BodySize {
			ev.Dedupe = true
		}
	}
	if !ev.Dedupe {
		f, err := os.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o666)
		switch {
		case err != nil:
			setupErr = err
		case c.write == "mmap" && req.BodySize > 0:
			ms, err := newMmapSink(f, req.BodySize, c.decodeFunc())
			if err != nil {
				f.Close()
				setupErr = err
			} else {
				s = ms
			}
		default:
			s = &pwriteSink{f: f, dec: c.decodeFunc()}
		}
	}
	if req.BodySize > 0 {
		if err := c.readBody(s, ev); err != nil {
			return nil, fmt.Errorf("put %d body: %v", req.ID, err)
		}
	}
	written, err := s.finish()
	ev.Decoded = time.Now().UnixNano()
	if setupErr != nil {
		err = setupErr
	}
	if err == nil && !ev.Dedupe {
		if written != req.BodySize {
			err = fmt.Errorf("decoded %d bytes, want %d", written, req.BodySize)
		} else {
			err = os.Rename(tmp, final)
		}
	}
	if err == nil {
		err = nativecache.WriteEntry(c.dir, req.ActionID, req.OutputID, req.BodySize)
	}
	if err != nil {
		os.Remove(tmp)
		ev.Err = err.Error()
		return &response{Err: err.Error()}, nil
	}
	return &response{DiskPath: final}, nil
}

func (c *client) readBody(s sink, ev *proglog.Event) error {
	b := c.in
	for {
		for b.r < b.w && b.buf[b.r] == '\n' {
			b.r++
		}
		if b.r < b.w {
			break
		}
		if err := b.fill(); err != nil {
			return err
		}
	}
	if b.buf[b.r] != '"' {
		return fmt.Errorf("body does not start with a quote")
	}
	b.r++
	ev.BodyStart = time.Now().UnixNano()
	reads0 := b.reads
	for {
		avail := b.buf[b.r:b.w]
		if q := bytes.IndexByte(avail, '"'); q >= 0 {
			ev.BodyEnd = b.lastRead
			if err := s.decode(avail[:q]); err != nil {
				return err
			}
			b.r += q + 1
			ev.Reads = b.reads - reads0
			return nil
		}
		k := len(avail) &^ 3
		if err := s.decode(avail[:k]); err != nil {
			return err
		}
		b.r += k
		if err := b.fill(); err != nil {
			return err
		}
	}
}
