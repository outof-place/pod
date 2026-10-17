package protocol

import (
	"bytes"
	"encoding/base64"
	"io"
)

type bodyState uint8

const (
	bodyDone    bodyState = iota // nothing left to read
	bodyPending                  // opening quote not read yet
	bodyData                     // inside the base64 string
	bodyBroken                   // malformed or truncated
)

// Body streams the decoded bytes of a put body: a JSON string of standard
// padded base64 after the request line. Read decodes straight into the
// caller's buffer; Discard skips the rest without decoding.
type Body struct {
	r        *Reader
	state    bodyState
	size     int64 // decoded bytes announced by BodySize
	encLeft  int64 // base64 characters not yet consumed
	decoded  int64 // decoded bytes handed out
	tail     [3]byte
	tailN    int
	tailUsed int
	err      error
	resync   bool // the failure was inside the string: skip to its line end
}

func (b *Body) reset(size int64) {
	*b = Body{r: b.r}
	if size > 0 {
		b.state = bodyPending
		b.size = size
		b.encLeft = (size + 2) / 3 * 4
	}
}

// Size is the decoded size announced by the request.
func (b *Body) Size() int64 { return b.size }

func (b *Body) fail(err error, resync bool) error {
	b.state = bodyBroken
	b.err = err
	b.resync = resync
	return err
}

// open consumes whitespace and the opening quote. Anything else is left in
// place for Next, which may find a request there.
func (b *Body) open() error {
	r := b.r
	for {
		for r.start < r.end {
			switch r.buf[r.start] {
			case ' ', '\t', '\r', '\n':
				r.start++
			case '"':
				r.start++
				b.state = bodyData
				return nil
			default:
				return b.fail(ErrMalformedBody, false)
			}
		}
		if !r.fill() {
			return b.fail(io.ErrUnexpectedEOF, false)
		}
	}
}

// closeQuote consumes the closing quote after the last base64 character.
func (b *Body) closeQuote() error {
	r := b.r
	if r.start == r.end && !r.fill() {
		return b.fail(io.ErrUnexpectedEOF, false)
	}
	if r.buf[r.start] != '"' {
		return b.fail(ErrMalformedBody, true)
	}
	r.start++
	b.state = bodyDone
	return nil
}

// Read decodes up to len(p) body bytes into p. It returns io.EOF once the
// whole body and its closing quote have been read.
func (b *Body) Read(p []byte) (int, error) {
	switch b.state {
	case bodyDone:
		return 0, io.EOF
	case bodyBroken:
		return 0, b.err
	case bodyPending:
		if err := b.open(); err != nil {
			return 0, err
		}
	}
	if b.tailUsed < b.tailN {
		n := copy(p, b.tail[b.tailUsed:b.tailN])
		b.tailUsed += n
		b.decoded += int64(n)
		return n, nil
	}
	if b.encLeft == 0 {
		if err := b.closeQuote(); err != nil {
			return 0, err
		}
		return 0, io.EOF
	}
	if len(p) == 0 {
		return 0, nil
	}
	r := b.r
	for r.end-r.start < 4 {
		if !r.fill() {
			return 0, b.fail(io.ErrUnexpectedEOF, false)
		}
	}
	if len(p) < 3 {
		// Too small for a whole group: decode one group into tail.
		n, err := b.decode(b.tail[:], r.buf[r.start:r.start+4])
		if err != nil {
			return 0, err
		}
		b.decoded -= int64(n)
		b.tailN, b.tailUsed = n, 0
		return b.Read(p)
	}
	k := min(int64(r.end-r.start)&^3, b.encLeft, int64(len(p)/3*4))
	return b.decode(p, r.buf[r.start:r.start+int(k)])
}

// decode decodes src (a multiple of 4 characters) into dst and checks that
// exactly the expected number of bytes came out, so padding or skipped
// characters anywhere but the end are caught.
func (b *Body) decode(dst, src []byte) (int, error) {
	want := len(src) / 4 * 3
	if int64(len(src)) == b.encLeft {
		want -= int(b.encLeft/4*3 - (b.size - b.decoded))
	}
	n, err := base64.StdEncoding.Decode(dst, src)
	if err != nil || n != want {
		return 0, b.fail(ErrMalformedBody, true)
	}
	b.r.start += len(src)
	b.encLeft -= int64(len(src))
	b.decoded += int64(n)
	return n, nil
}

// Discard skips the rest of the body without decoding it, checks its framing
// (closing quote at the announced length) and leaves the reader at the next
// request.
func (b *Body) Discard() error {
	err := b.discard()
	if b.state == bodyBroken && b.resync {
		b.r.skipLine()
	}
	b.state = bodyDone
	return err
}

func (b *Body) discard() error {
	switch b.state {
	case bodyDone:
		return nil
	case bodyBroken:
		return b.err
	case bodyPending:
		if err := b.open(); err != nil {
			return err
		}
	}
	b.tailUsed = b.tailN
	r := b.r
	for b.encLeft > 0 {
		if r.start == r.end && !r.fill() {
			return b.fail(io.ErrUnexpectedEOF, false)
		}
		k := min(int64(r.end-r.start), b.encLeft)
		chunk := r.buf[r.start : r.start+int(k)]
		if i := firstStop(chunk); i >= 0 {
			r.start += i
			return b.fail(ErrMalformedBody, true)
		}
		r.start += int(k)
		b.encLeft -= k
	}
	return b.closeQuote()
}

// firstStop finds a quote or newline: either ends the string early.
func firstStop(chunk []byte) int {
	i := bytes.IndexByte(chunk, '"')
	if j := bytes.IndexByte(chunk, '\n'); j >= 0 && (i < 0 || j < i) {
		i = j
	}
	return i
}
