package protocol

import (
	"encoding/base64"
	"io"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"
)

// flushAt is the buffered size past which a response is written at once.
const flushAt = 32 << 10

// Writer encodes responses into a reused buffer. Responses go out on Flush,
// which the reader calls before it blocks, or once flushAt bytes are pending.
// It is safe for concurrent use, so later stages can answer out of order.
type Writer struct {
	mu  sync.Mutex
	w   io.Writer
	buf []byte
	err error
}

// NewWriter returns a Writer on w.
func NewWriter(w io.Writer) *Writer {
	return &Writer{w: w, buf: make([]byte, 0, 2*flushAt)}
}

// Hello queues the first message: the known commands, ID 0.
func (w *Writer) Hello() {
	w.mu.Lock()
	b := append(w.buf, `{"ID":0,"KnownCommands":[`...)
	for i, c := range KnownCommands {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '"')
		b = append(b, c...)
		b = append(b, '"')
	}
	w.buf = append(b, "]}\n"...)
	w.queuedLocked()
}

// Hit queues a get hit.
func (w *Writer) Hit(id int64, out *[HashSize]byte, size int64, unixNano int64, diskPath []byte) {
	w.mu.Lock()
	b := w.begin(id)
	b = append(b, `,"OutputID":"`...)
	b = base64.StdEncoding.AppendEncode(b, out[:])
	b = append(b, `","Size":`...)
	b = strconv.AppendInt(b, size, 10)
	b = append(b, `,"Time":"`...)
	b = time.Unix(0, unixNano).UTC().AppendFormat(b, time.RFC3339Nano)
	b = append(b, `","DiskPath":`...)
	b = appendString(b, diskPath)
	w.buf = append(b, "}\n"...)
	w.queuedLocked()
}

// Miss queues a get miss.
func (w *Writer) Miss(id int64) {
	w.mu.Lock()
	w.buf = append(w.begin(id), `,"Miss":true}`+"\n"...)
	w.queuedLocked()
}

// Put queues a put reply.
func (w *Writer) Put(id int64, diskPath []byte) {
	w.mu.Lock()
	b := append(w.begin(id), `,"DiskPath":`...)
	b = appendString(b, diskPath)
	w.buf = append(b, "}\n"...)
	w.queuedLocked()
}

// Done queues a reply with no fields (close).
func (w *Writer) Done(id int64) {
	w.mu.Lock()
	w.buf = append(w.begin(id), "}\n"...)
	w.queuedLocked()
}

// Error queues an error reply.
func (w *Writer) Error(id int64, msg string) {
	w.mu.Lock()
	b := append(w.begin(id), `,"Err":`...)
	b = appendString(b, []byte(msg))
	w.buf = append(b, "}\n"...)
	w.queuedLocked()
}

func (w *Writer) begin(id int64) []byte {
	b := append(w.buf, `{"ID":`...)
	return strconv.AppendInt(b, id, 10)
}

// queuedLocked flushes a full buffer and unlocks.
func (w *Writer) queuedLocked() {
	if len(w.buf) >= flushAt {
		w.flushLocked()
	}
	w.mu.Unlock()
}

// Flush writes all queued responses.
func (w *Writer) Flush() {
	w.mu.Lock()
	w.flushLocked()
	w.mu.Unlock()
}

func (w *Writer) flushLocked() {
	if len(w.buf) == 0 || w.err != nil {
		w.buf = w.buf[:0]
		return
	}
	_, w.err = w.w.Write(w.buf)
	w.buf = w.buf[:0]
}

// Err is the first write error; after one, responses are dropped.
func (w *Writer) Err() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.err
}

const hexDigits = "0123456789abcdef"

// appendString appends s as a JSON string. Callers pass valid UTF-8 (the
// client refuses a store path that is not), so only quotes, backslashes and
// control characters need escaping.
func appendString(b, s []byte) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == '"' || c == '\\':
			b = append(b, '\\', c)
		case c < 0x20:
			b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
		case c < utf8.RuneSelf:
			b = append(b, c)
		default:
			r, n := utf8.DecodeRune(s[i:])
			if r == utf8.RuneError && n == 1 {
				b = append(b, `�`...)
			} else {
				b = append(b, s[i:i+n]...)
			}
			i += n
			continue
		}
		i++
	}
	return append(b, '"')
}
