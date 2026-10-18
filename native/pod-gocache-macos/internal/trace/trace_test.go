package trace

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func id(b byte) *[32]byte {
	var x [32]byte
	for i := range x {
		x[i] = b + byte(i)
	}
	return &x
}

func TestRecordsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	before := time.Now().UnixNano()
	r := New(dir)
	r.Record(OpGetHit, id(1), id(0x80), 1234, 1500*time.Microsecond)
	r.Record(OpGetMiss, id(2), nil, 0, time.Hour)
	r.Close(OpClose)
	after := time.Now().UnixNano()

	recs, err := ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 4 {
		t.Fatalf("got %d records: %+v", len(recs), recs)
	}
	wantOps := []Op{OpStart, OpGetHit, OpGetMiss, OpClose}
	for i, rec := range recs {
		if rec.Op != wantOps[i] || rec.PID != uint32(os.Getpid()) || rec.Time < before || rec.Time > after {
			t.Errorf("record %d: %+v", i, rec)
		}
		if i > 0 && rec.Time < recs[i-1].Time {
			t.Errorf("time went backwards at %d", i)
		}
	}
	hit := recs[1]
	if hit.Action != 0x0102030405060708 || hit.Output != 0x8081828384858687 || hit.Size != 1234 || hit.Micros != 1500 {
		t.Errorf("hit record: %+v", hit)
	}
	if recs[2].Micros != 0xffff || recs[2].Output != 0 {
		t.Errorf("miss record: %+v", recs[2])
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 || !fileNameRE.MatchString(ents[0].Name()) {
		t.Fatalf("want one session file named <20 digits>-<pid>.pgtrace, got %v", ents)
	}
	fi, _ := ents[0].Info()
	if fi.Size() != 4*RecordSize || fi.Mode().Perm() != 0o600 {
		t.Errorf("session file: size %d mode %v", fi.Size(), fi.Mode())
	}
	stamp, _ := strconv.ParseInt(ents[0].Name()[:20], 10, 64)
	if stamp < before || stamp > recs[0].Time {
		t.Errorf("file %s is stamped %d, not the session start (%d..%d)", ents[0].Name(), stamp, before, recs[0].Time)
	}
}

var fileNameRE = regexp.MustCompile(`^\d{20}-\d+\.pgtrace$`)

// Many sessions over a small cap: the directory stays within it after every
// session, and the newest records survive.
func TestRotationKeepsTheCap(t *testing.T) {
	dir := t.TempDir()
	const rotateAt, maxTotal = 64 << 10, 256 << 10
	for s := range 40 {
		r := newRecorder(dir, rotateAt, maxTotal)
		for i := range 2000 {
			r.Record(OpGetHit, id(byte(s)), id(byte(i)), int64(i), 0)
		}
		r.Close(OpClose)
		total := int64(0)
		ents, _ := os.ReadDir(dir)
		for _, e := range ents {
			fi, _ := e.Info()
			total += fi.Size()
			if !strings.HasSuffix(e.Name(), Suffix) {
				t.Fatalf("unexpected file %s", e.Name())
			}
		}
		if total > maxTotal {
			t.Fatalf("session %d: %d bytes on disk, cap %d", s, total, maxTotal)
		}
	}
	recs, err := ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	last := recs[len(recs)-1]
	if last.Op != OpClose || recs[len(recs)-2].Action != IDKey(id(39)) {
		t.Fatalf("newest records missing: last %+v", last)
	}
}

// A trace directory that cannot be created costs nothing and breaks nothing.
func TestUnwritableDirIsIgnored(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "file")
	os.WriteFile(blocker, nil, 0o600)
	r := New(filepath.Join(blocker, "trace"))
	for i := range 10000 {
		r.Record(OpGetMiss, id(byte(i)), nil, 0, 0)
	}
	r.Close(OpEOF)
	var nilRec *Recorder
	nilRec.Record(OpGetHit, id(1), id(2), 3, 4)
	nilRec.Close(OpClose)
}

func TestDecodeRejectsUnknown(t *testing.T) {
	var b [RecordSize]byte
	Record{Op: OpGetHit}.Encode(b[:])
	if _, ok := Decode(b[:]); !ok {
		t.Fatal("valid record rejected")
	}
	b[39] = Version + 1
	if _, ok := Decode(b[:]); ok {
		t.Fatal("unknown version accepted")
	}
	b[39], b[38] = Version, byte(opLast)+1
	if _, ok := Decode(b[:]); ok {
		t.Fatal("unknown op accepted")
	}
}

// Recording is on every request's path: it must not allocate.
func TestRecordAllocations(t *testing.T) {
	r := New(t.TempDir())
	defer r.Close(OpClose)
	a, o := id(1), id(2)
	allocs := testing.AllocsPerRun(1000, func() { r.Record(OpGetHit, a, o, 10, time.Microsecond) })
	if allocs != 0 {
		t.Fatalf("%v allocations per record", allocs)
	}
}

// Sessions running at once each write their own file: no record of one lands in
// another's file, every file starts with its own session start, and a record
// is never torn.
func TestConcurrentSessionsKeepSeparateFiles(t *testing.T) {
	dir := t.TempDir()
	const sessions, perSession = 24, 3000
	var wg sync.WaitGroup
	for s := range sessions {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := New(dir)
			for i := range perSession {
				r.Record(OpGetHit, id(byte(s)), id(byte(i)), int64(s), 0)
			}
			r.Close(OpClose)
		}()
	}
	wg.Wait()

	files, err := traceFiles(dir)
	if err != nil || len(files) != sessions {
		t.Fatalf("%d files (err %v), want one per session (%d)", len(files), err, sessions)
	}
	for _, e := range files {
		data, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		if len(data)%RecordSize != 0 {
			t.Errorf("%s: torn at %d bytes", e.Name(), len(data))
		}
		first, _ := Decode(data)
		if first.Op != OpStart {
			t.Errorf("%s does not start with its session start: %+v", e.Name(), first)
		}
		owner := int64(-1)
		for off := RecordSize; off+RecordSize <= len(data); off += RecordSize {
			rec, ok := Decode(data[off:])
			if !ok {
				t.Fatalf("%s: undecodable record at %d", e.Name(), off)
			}
			if rec.Op != OpGetHit {
				continue
			}
			if owner >= 0 && rec.Size != owner {
				t.Fatalf("%s mixes sessions %d and %d", e.Name(), owner, rec.Size)
			}
			owner = rec.Size
		}
	}
}

// Concurrent sessions that rotate and prune against one small cap: the
// directory ends within it, and what is left decodes.
func TestConcurrentSessionsPrune(t *testing.T) {
	dir := t.TempDir()
	const rotateAt, maxTotal = 32 << 10, 128 << 10
	var wg sync.WaitGroup
	for s := range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 4 {
				r := newRecorder(dir, rotateAt, maxTotal)
				for i := range 1500 {
					r.Record(OpGetMiss, id(byte(s)), nil, int64(i), 0)
				}
				r.Close(OpClose)
			}
		}()
	}
	wg.Wait()
	// Each Close prunes, but a session finishing last may have raced another's
	// final write: one more prune settles the directory.
	prune(dir, maxTotal)
	var total int64
	ents, _ := traceFiles(dir)
	for _, e := range ents {
		fi, _ := e.Info()
		total += fi.Size()
	}
	if total > maxTotal || len(ents) == 0 {
		t.Fatalf("%d bytes in %d files, cap %d", total, len(ents), maxTotal)
	}
	recs, err := ReadDir(dir)
	if err != nil || len(recs) == 0 {
		t.Fatalf("reading what is left: %d records, %v", len(recs), err)
	}
}

// A short write (a full disk) leaves a torn last record in that session's file
// only: readers keep every whole record and the other files are unaffected.
func TestTornTailOnlyCostsItsOwnFile(t *testing.T) {
	dir := t.TempDir()
	good := New(dir)
	good.Record(OpGetHit, id(1), id(2), 7, 0)
	good.Close(OpClose)

	torn := make([]byte, 3*RecordSize+19) // three whole records and a partial fourth
	for i := range 3 {
		Record{Time: int64(1000 + i), Op: OpGetMiss, PID: 99}.Encode(torn[i*RecordSize:])
	}
	if err := os.WriteFile(filepath.Join(dir, fileName(1, 99)), torn, 0o600); err != nil {
		t.Fatal(err)
	}
	recs, err := ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 3+3 {
		t.Fatalf("got %d records, want the 3 whole ones of the torn file and the 3 of the good one: %+v", len(recs), recs)
	}
	for i := 1; i < len(recs); i++ {
		if recs[i].Time < recs[i-1].Time {
			t.Fatalf("records not in time order at %d", i)
		}
	}
}

// stuckFile is a trace file whose writes block until release is closed.
type stuckFile struct {
	release chan struct{}
	wrote   atomic.Int64
}

func (f *stuckFile) Write(p []byte) (int, error) {
	<-f.release
	f.wrote.Add(int64(len(p)))
	return len(p), nil
}

func (f *stuckFile) Close() error { return nil }

func stuckRecorder() (*Recorder, *stuckFile) {
	f := &stuckFile{release: make(chan struct{})}
	r := newRecorder(os.TempDir(), defaultRotateAt, defaultMaxTotal)
	r.open = func(string, int64, uint32) (io.WriteCloser, error) { return f, nil }
	return r, f
}

// A flusher stuck on the disk never holds up the request path: records are
// dropped instead.
func TestStuckFlusherDoesNotBlockRecording(t *testing.T) {
	closeTimeout = 50 * time.Millisecond
	t.Cleanup(func() { closeTimeout = 2 * time.Second })
	r, f := stuckRecorder()
	const records = 5 * bufCount * bufSize / RecordSize
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range records {
			r.Record(OpGetMiss, id(1), nil, int64(i), 0)
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Record blocked behind a stuck flusher")
	}
	r.Close(OpClose)
	close(f.release)
	<-r.done
	if got := f.wrote.Load(); got == 0 || got > bufCount*bufSize {
		t.Fatalf("%d bytes reached the file: want some, and no more than the buffers hold (%d of %d records were offered)", got, bufCount*bufSize/RecordSize, records)
	}
}

// Close gives up on a stuck disk after closeTimeout instead of hanging the
// process the go command is waiting on.
func TestCloseIsBounded(t *testing.T) {
	closeTimeout = 100 * time.Millisecond
	t.Cleanup(func() { closeTimeout = 2 * time.Second })
	r, f := stuckRecorder()
	defer close(f.release)
	done := make(chan time.Duration)
	go func() {
		start := time.Now()
		r.Close(OpClose)
		done <- time.Since(start)
	}()
	select {
	case took := <-done:
		if took < closeTimeout {
			t.Fatalf("Close returned after %v, before the flusher could have finished", took)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close waits forever for a stuck flusher")
	}
}
