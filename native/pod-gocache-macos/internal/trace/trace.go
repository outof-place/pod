// Package trace records every get and put of a client session as fixed-size
// binary records in the session's own file of a size-capped directory, so the eviction
// policy can be chosen by replaying real traffic. Recording is best effort:
// it buffers in memory, writes off the request path, and drops records rather
// than wait.
package trace

import (
	"cmp"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Op is what a record describes.
type Op uint8

const (
	OpStart       Op = 1 // session started
	OpGetHit      Op = 2
	OpGetMiss     Op = 3
	OpPutStored   Op = 4 // output written into the store
	OpPutExisting Op = 5 // output already in the store and verified, body skipped
	OpPutFailed   Op = 6 // put answered with an error
	OpClose       Op = 7 // session ended by the go command's close
	OpEOF         Op = 8 // session ended without close (go list, or go died)
)

// RecordSize is the size of one encoded record.
const RecordSize = 40

// Version is the record format version, stored in every record's last byte.
const Version = 1

// Record is one decoded record.
type Record struct {
	Time   int64  // unix nanoseconds: session wall-clock start plus monotonic elapsed time
	Action uint64 // first 8 bytes of the ActionID, big-endian; 0 for session records
	Output uint64 // first 8 bytes of the OutputID; 0 when unknown
	Size   int64  // body size in bytes
	PID    uint32 // client process
	Micros uint16 // time spent serving, saturating
	Op     Op
}

// Encode writes r into b (len >= RecordSize), little-endian.
func (r Record) Encode(b []byte) {
	_ = b[RecordSize-1]
	binary.LittleEndian.PutUint64(b[0:], uint64(r.Time))
	binary.LittleEndian.PutUint64(b[8:], r.Action)
	binary.LittleEndian.PutUint64(b[16:], r.Output)
	binary.LittleEndian.PutUint64(b[24:], uint64(r.Size))
	binary.LittleEndian.PutUint32(b[32:], r.PID)
	binary.LittleEndian.PutUint16(b[36:], r.Micros)
	b[38] = byte(r.Op)
	b[39] = Version
}

// Decode reads one record. ok is false for an unknown version or op.
func Decode(b []byte) (r Record, ok bool) {
	if len(b) < RecordSize || b[39] != Version || b[38] < byte(OpStart) || b[38] > byte(OpEOF) {
		return r, false
	}
	r.Time = int64(binary.LittleEndian.Uint64(b[0:]))
	r.Action = binary.LittleEndian.Uint64(b[8:])
	r.Output = binary.LittleEndian.Uint64(b[16:])
	r.Size = int64(binary.LittleEndian.Uint64(b[24:]))
	r.PID = binary.LittleEndian.Uint32(b[32:])
	r.Micros = binary.LittleEndian.Uint16(b[36:])
	r.Op = Op(b[38])
	return r, true
}

// IDKey is the 8-byte prefix of an ID stored in records.
func IDKey(id *[32]byte) uint64 {
	if id == nil {
		return 0
	}
	return binary.BigEndian.Uint64(id[:8])
}

const (
	// Suffix ends every trace file, named "<unix nanoseconds, 20 digits>-<pid>.pgtrace".
	Suffix = ".pgtrace"

	defaultRotateAt = 8 << 20
	defaultMaxTotal = 64 << 20
	bufSize         = 1638 * RecordSize // ~64 KiB
	bufCount        = 3
)

// closeTimeout bounds how long Close waits for the flusher: a stalled disk
// must not keep the process, and so the go command's stdout reader, waiting.
var closeTimeout = 2 * time.Second

// Recorder buffers records and appends them to the session's own file in the
// trace directory. A nil Recorder records nothing.
type Recorder struct {
	dir       string
	pid       uint32
	wallStart int64
	monoStart time.Time
	rotateAt  int64
	maxTotal  int64
	open      func(dir string, stamp int64, pid uint32) (io.WriteCloser, error)

	mu      sync.Mutex
	cur     []byte
	spare   chan []byte
	full    chan []byte
	running bool
	done    chan struct{}
	closed  bool

	// Owned by the flusher.
	f     io.WriteCloser
	size  int64
	files int // files this session created
}

// New returns a Recorder writing under dir and records the session start.
func New(dir string) *Recorder {
	return newRecorder(dir, defaultRotateAt, defaultMaxTotal)
}

func newRecorder(dir string, rotateAt, maxTotal int64) *Recorder {
	now := time.Now()
	r := &Recorder{
		dir:       dir,
		pid:       uint32(os.Getpid()),
		wallStart: now.UnixNano(),
		monoStart: now,
		rotateAt:  rotateAt,
		maxTotal:  maxTotal,
		open:      createSessionFile,
		cur:       make([]byte, 0, bufSize),
		spare:     make(chan []byte, bufCount),
		full:      make(chan []byte, bufCount),
	}
	for range bufCount - 1 {
		r.spare <- make([]byte, 0, bufSize)
	}
	r.add(OpStart, 0, 0, 0, 0)
	return r
}

// Record adds a get or put record.
func (r *Recorder) Record(op Op, action, output *[32]byte, size int64, took time.Duration) {
	if r == nil {
		return
	}
	r.add(op, IDKey(action), IDKey(output), size, took)
}

func (r *Recorder) add(op Op, action, output uint64, size int64, took time.Duration) {
	us := took.Microseconds()
	if us > 0xffff {
		us = 0xffff
	}
	rec := Record{
		Time:   r.wallStart + int64(time.Since(r.monoStart)),
		Action: action,
		Output: output,
		Size:   size,
		PID:    r.pid,
		Micros: uint16(max(us, 0)),
		Op:     op,
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	if len(r.cur)+RecordSize > cap(r.cur) && !r.handOff() {
		return // the flusher is behind: drop rather than wait
	}
	n := len(r.cur)
	r.cur = r.cur[:n+RecordSize]
	rec.Encode(r.cur[n:])
}

// handOff passes the full buffer to the flusher and takes a spare one. It
// reports false, keeping the buffer, when no spare is free.
func (r *Recorder) handOff() bool {
	select {
	case next := <-r.spare:
		r.startFlusher()
		r.full <- r.cur
		r.cur = next[:0]
		return true
	default:
		return false
	}
}

// startFlusher starts the flusher goroutine once. Callers hold r.mu.
func (r *Recorder) startFlusher() {
	if !r.running {
		r.running = true
		r.done = make(chan struct{})
		go r.flushLoop()
	}
}

func (r *Recorder) flushLoop() {
	defer close(r.done)
	for buf := range r.full {
		r.write(buf)
		r.spare <- buf[:0]
	}
	if r.f != nil {
		r.f.Close()
		r.f = nil
	}
	if r.files > 0 {
		prune(r.dir, r.maxTotal)
	}
}

// Close records the session end and writes everything still buffered, waiting
// at most closeTimeout for the disk.
func (r *Recorder) Close(end Op) {
	if r == nil {
		return
	}
	r.add(end, 0, 0, 0, 0)
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.startFlusher()
	last, done := r.cur, r.done
	r.cur = nil
	r.mu.Unlock()
	r.full <- last // never blocks: bufCount buffers exist and last is one of them
	close(r.full)
	t := time.NewTimer(closeTimeout)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
	}
}

// write appends buf to the session's current file and moves to a new file
// when it is full. Any failure turns tracing off for the session.
func (r *Recorder) write(buf []byte) {
	if len(buf) == 0 || r.dir == "" {
		return
	}
	if r.f == nil {
		stamp := r.wallStart
		if r.files > 0 {
			stamp = time.Now().UnixNano()
		}
		f, err := r.open(r.dir, stamp, r.pid)
		if err != nil {
			r.dir = ""
			return
		}
		r.f, r.size = f, 0
		r.files++
	}
	n, err := r.f.Write(buf)
	r.size += int64(n)
	if err != nil {
		// A torn tail stays at the end of this file: readers ignore it.
		r.f.Close()
		r.f, r.dir = nil, ""
		return
	}
	if r.size >= r.rotateAt {
		r.f.Close()
		r.f = nil
		prune(r.dir, r.maxTotal)
	}
}

// fileName is "<unix nanoseconds, 20 digits>-<pid>.pgtrace": names sort by start.
func fileName(stamp int64, pid uint32) string {
	ns := strconv.FormatInt(stamp, 10)
	return strings.Repeat("0", max(0, 20-len(ns))) + ns + "-" + strconv.FormatUint(uint64(pid), 10) + Suffix
}

// createSessionFile makes a new trace file. A name already taken (the same
// process rotating or starting in the same nanosecond) moves the stamp on.
func createSessionFile(dir string, stamp int64, pid uint32) (io.WriteCloser, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	for range 16 {
		f, err := os.OpenFile(filepath.Join(dir, fileName(stamp, pid)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if !errors.Is(err, os.ErrExist) {
			return f, err
		}
		stamp++
	}
	return nil, os.ErrExist
}

// traceFiles lists the trace files in dir, oldest start first.
func traceFiles(dir string) ([]os.DirEntry, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	files := ents[:0]
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), Suffix) {
			files = append(files, e)
		}
	}
	return files, nil
}

// prune deletes the least recently written files until the directory holds at
// most keep bytes. Files other sessions are still appending to have the
// newest mtimes, so they go last.
func prune(dir string, keep int64) {
	ents, err := traceFiles(dir)
	if err != nil {
		return
	}
	type file struct {
		name  string
		size  int64
		mtime time.Time
	}
	files := make([]file, 0, len(ents))
	var total int64
	for _, e := range ents {
		fi, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, file{e.Name(), fi.Size(), fi.ModTime()})
		total += fi.Size()
	}
	slices.SortFunc(files, func(a, b file) int {
		if c := a.mtime.Compare(b.mtime); c != 0 {
			return c
		}
		return strings.Compare(a.name, b.name)
	})
	for _, f := range files {
		if total <= keep {
			return
		}
		if os.Remove(filepath.Join(dir, f.name)) == nil {
			total -= f.size
		}
	}
}

// ReadDir returns every decodable record in dir, ordered by time. A file's
// torn last record (a short write) and records with an unknown version are
// skipped.
func ReadDir(dir string) ([]Record, error) {
	ents, err := traceFiles(dir)
	if err != nil {
		return nil, err
	}
	var out []Record
	for _, e := range ents {
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if errors.Is(err, os.ErrNotExist) {
			continue // pruned meanwhile
		}
		if err != nil {
			return out, err
		}
		for len(data) >= RecordSize {
			if rec, ok := Decode(data); ok {
				out = append(out, rec)
			}
			data = data[RecordSize:]
		}
	}
	slices.SortStableFunc(out, func(a, b Record) int { return cmp.Compare(a.Time, b.Time) })
	return out, nil
}

// DefaultDir is ~/.pod/gocache/trace.
func DefaultDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pod", "gocache", "trace"), nil
}
