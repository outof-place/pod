package store

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// bytesBody is a Body over a byte slice that records how it was consumed.
type bytesBody struct {
	r         *bytes.Reader
	failAt    int // Read fails once this many bytes were read (0: never)
	read      int
	discarded bool
}

func body(data []byte) *bytesBody { return &bytesBody{r: bytes.NewReader(data)} }

func (b *bytesBody) Read(p []byte) (int, error) {
	if b.failAt > 0 && b.read >= b.failAt {
		return 0, errors.New("stream broke")
	}
	n, err := b.r.Read(p)
	b.read += n
	return n, err
}

func (b *bytesBody) Discard() error {
	b.discarded = true
	b.r.Seek(0, io.SeekEnd)
	return nil
}

func (b *bytesBody) consumed() bool { return b.discarded || b.r.Len() == 0 }

func newStore(t testing.TB) (*Store, string) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return Open(dir), dir
}

func put(t testing.TB, s *Store, id [hashSize]byte, data []byte) PutResult {
	t.Helper()
	out := sha256.Sum256(data)
	var res PutResult
	if err := s.Put(&id, &out, true, int64(len(data)), body(data), &res); err != nil {
		t.Fatalf("Put: %v", err)
	}
	return res
}

func entryFile(dir string, id [hashSize]byte, kind string) string {
	var p pathBuf
	s := Store{dir: dir}
	return string([]byte(s.entryPath(&p, &id, kind[0])))
}

// noTemps fails when a temp file or anything else unexpected is in a bucket.
func noTemps(t *testing.T, dir string) {
	t.Helper()
	filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(d.Name(), TempPrefix) {
			t.Errorf("temp file left: %s", path)
		}
		return nil
	})
}

// The daemon sweeps temp files by name: what createTemp makes must parse, and
// look-alikes must not.
func TestParseTempName(t *testing.T) {
	s, dir := newStore(t)
	var p pathBuf
	out := testID(9)
	fd, err := s.createTemp(&p, &out)
	if err != nil {
		t.Fatal(err)
	}
	syscall.Close(fd)
	ents, _ := os.ReadDir(filepath.Dir(string(p.bytes())))
	if len(ents) != 1 {
		t.Fatalf("bucket under %s holds %d files", dir, len(ents))
	}
	pid, seq, ok := ParseTempName(ents[0].Name())
	if !ok || pid != uint64(os.Getpid()) || seq != s.seq.Load() {
		t.Fatalf("%s parsed as %d %d %v", ents[0].Name(), pid, seq, ok)
	}
	for _, bad := range []string{"", ".pgc-tmp.", ".pgc-tmp.1", ".pgc-tmp.1.", ".pgc-tmp..2", ".pgc-tmp.+1.2", ".pgc-tmp.-1.2", ".pgc-tmp.1.2.3", ".pgc-tmp.x.2", ".pgc-tmp.99999999999.2", "pgc-tmp.1.2", "ab-a", "ab-d"} {
		if _, _, ok := ParseTempName(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestPutThenGet(t *testing.T) {
	s, dir := newStore(t)
	id := testID(7)
	data := []byte("compiled archive bytes")
	before := time.Now()
	res := put(t, s, id, data)
	after := time.Now()
	out := sha256.Sum256(data)

	if res.Outcome != Stored || string(res.DiskPath()) != entryFile(dir, out, "d") {
		t.Fatalf("put: outcome %d path %s", res.Outcome, res.DiskPath())
	}
	var h Hit
	if !s.Get(&id, &h) {
		t.Fatal("miss after put")
	}
	if h.OutputID != out || h.Size != int64(len(data)) || string(h.DiskPath()) != entryFile(dir, out, "d") {
		t.Fatalf("hit %x %d %s", h.OutputID, h.Size, h.DiskPath())
	}
	if h.Time < before.UnixNano() || h.Time > after.UnixNano() {
		t.Fatalf("entry time %d outside the put (%d..%d)", h.Time, before.UnixNano(), after.UnixNano())
	}
	got, _ := os.ReadFile(string(h.DiskPath()))
	if !bytes.Equal(got, data) {
		t.Fatalf("output content %q", got)
	}
	line, _ := os.ReadFile(entryFile(dir, id, "a"))
	if want := goFormat(id, out, int64(len(data)), h.Time); string(line) != want {
		t.Fatalf("index entry\n got %q\nwant %q", line, want)
	}
	noTemps(t, dir)
}

// An entry exactly as the built-in cache writes it is a hit with its time.
func TestGetReadsBuiltinEntries(t *testing.T) {
	s, dir := newStore(t)
	id, data := testID(9), []byte("from go")
	out := sha256.Sum256(data)
	const tm = 1792245446101594250
	os.MkdirAll(filepath.Dir(entryFile(dir, id, "a")), 0o777)
	os.MkdirAll(filepath.Dir(entryFile(dir, out, "d")), 0o777)
	os.WriteFile(entryFile(dir, id, "a"), []byte(goFormat(id, out, int64(len(data)), tm)), 0o666)
	os.WriteFile(entryFile(dir, out, "d"), data, 0o666)
	var h Hit
	if !s.Get(&id, &h) || h.Time != tm || h.OutputID != out || h.Size != int64(len(data)) {
		t.Fatalf("got hit=%+v", h)
	}
}

func TestGetMisses(t *testing.T) {
	cases := map[string]func(dir string, id, out [hashSize]byte){
		"no entry":        func(dir string, id, out [hashSize]byte) { os.Remove(entryFile(dir, id, "a")) },
		"output missing":  func(dir string, id, out [hashSize]byte) { os.Remove(entryFile(dir, out, "d")) },
		"output short":    func(dir string, id, out [hashSize]byte) { os.WriteFile(entryFile(dir, out, "d"), []byte("x"), 0o666) },
		"entry truncated": func(dir string, id, out [hashSize]byte) { os.Truncate(entryFile(dir, id, "a"), entrySize-1) },
		"entry for another id": func(dir string, id, out [hashSize]byte) {
			os.WriteFile(entryFile(dir, id, "a"), []byte(goFormat(testID(99), out, 5, 1)), 0o666)
		},
		"output empty dir": func(dir string, id, out [hashSize]byte) {
			os.Remove(entryFile(dir, out, "d"))
			os.Mkdir(entryFile(dir, out, "d"), 0o777)
		},
	}
	for name, breakIt := range cases {
		s, dir := newStore(t)
		id, data := testID(3), []byte("12345")
		put(t, s, id, data)
		breakIt(dir, id, sha256.Sum256(data))
		var h Hit
		if s.Get(&id, &h) {
			t.Errorf("%s: hit", name)
		}
	}
}

// The built-in cache stores go run executables as a -d directory holding one
// file; the hit is that file.
func TestGetExecutableEntry(t *testing.T) {
	s, dir := newStore(t)
	id, exe := testID(4), []byte("\xcf\xfa\xed\xfe binary")
	out := sha256.Sum256(exe)
	os.MkdirAll(filepath.Dir(entryFile(dir, id, "a")), 0o777)
	os.MkdirAll(entryFile(dir, out, "d"), 0o777)
	inner := filepath.Join(entryFile(dir, out, "d"), "hello")
	os.WriteFile(inner, exe, 0o777)
	os.WriteFile(entryFile(dir, id, "a"), []byte(goFormat(id, out, int64(len(exe)), 5)), 0o666)
	var h Hit
	if !s.Get(&id, &h) || string(h.DiskPath()) != inner {
		t.Fatalf("hit=%v path %s", s.Get(&id, &h), h.DiskPath())
	}
}

// Like markUsed in cache.go: a hit refreshes mtimes older than an hour, and
// leaves younger ones alone (59 and 61 minutes straddle the boundary).
func TestGetRefreshesOldMtimes(t *testing.T) {
	s, dir := newStore(t)
	id, data := testID(5), []byte("used all day")
	put(t, s, id, data)
	files := []string{entryFile(dir, id, "a"), entryFile(dir, sha256.Sum256(data), "d")}
	for _, age := range []time.Duration{59 * time.Minute, 61 * time.Minute} {
		old := time.Now().Add(-age).Truncate(time.Second)
		for _, f := range files {
			os.Chtimes(f, old, old)
		}
		var h Hit
		if !s.Get(&id, &h) {
			t.Fatal("miss")
		}
		for _, f := range files {
			fi, _ := os.Stat(f)
			refreshed := time.Since(fi.ModTime()) < time.Minute
			if want := age > time.Hour; refreshed != want {
				t.Errorf("age %v: %s refreshed=%v, want %v", age, filepath.Base(f), refreshed, want)
			}
		}
	}
}

// An existing output is reused only after its hash checks out; a same-size
// file with other bytes (a half-written built-in output) is replaced.
func TestPutExistingOutput(t *testing.T) {
	s, dir := newStore(t)
	data := []byte("same output, two actions")
	put(t, s, testID(1), data)
	dfile := entryFile(dir, sha256.Sum256(data), "d")
	fi1, _ := os.Stat(dfile)

	id2 := testID(2)
	out := sha256.Sum256(data)
	b := body(data)
	var res PutResult
	if err := s.Put(&id2, &out, true, int64(len(data)), b, &res); err != nil || res.Outcome != Existing || !b.discarded {
		t.Fatalf("second put: err %v outcome %d discarded %v", err, res.Outcome, b.discarded)
	}
	fi2, _ := os.Stat(dfile)
	if !os.SameFile(fi1, fi2) {
		t.Fatal("verified output was rewritten")
	}

	os.WriteFile(dfile, bytes.Repeat([]byte{0}, len(data)), 0o666)
	b = body(data)
	if err := s.Put(&id2, &out, true, int64(len(data)), b, &res); err != nil || res.Outcome != Stored {
		t.Fatalf("put over a corrupt output: err %v outcome %d", err, res.Outcome)
	}
	if got, _ := os.ReadFile(dfile); !bytes.Equal(got, data) {
		t.Fatalf("corrupt output not replaced: %q", got)
	}
	var h Hit
	if !s.Get(&id2, &h) {
		t.Fatal("miss")
	}
}

// Failed puts leave nothing new in the store and always consume the body.
func TestPutFailuresLeaveNothing(t *testing.T) {
	data := bytes.Repeat([]byte("abcdefgh"), 300_000) // spans several stream buffers
	out := sha256.Sum256(data)
	cases := map[string]func(s *Store, dir string) (*bytesBody, [hashSize]byte){
		"hash mismatch": func(s *Store, dir string) (*bytesBody, [hashSize]byte) {
			wrong := append([]byte(nil), data...)
			wrong[len(wrong)-1] ^= 1
			return body(wrong), out
		},
		"stream breaks": func(s *Store, dir string) (*bytesBody, [hashSize]byte) {
			b := body(data)
			b.failAt = len(data) / 2
			return b, out
		},
		"read-only bucket": func(s *Store, dir string) (*bytesBody, [hashSize]byte) {
			bucket := filepath.Dir(entryFile(dir, out, "d"))
			os.MkdirAll(bucket, 0o777)
			os.Chmod(bucket, 0o555)
			t.Cleanup(func() { os.Chmod(bucket, 0o777) })
			return body(data), out
		},
	}
	for name, setup := range cases {
		s, dir := newStore(t)
		id := testID(6)
		b, o := setup(s, dir)
		var res PutResult
		err := s.Put(&id, &o, true, int64(len(data)), b, &res)
		if err == nil {
			t.Errorf("%s: no error", name)
		}
		if name != "stream breaks" && !b.consumed() {
			t.Errorf("%s: body not consumed", name)
		}
		for _, f := range []string{entryFile(dir, id, "a"), entryFile(dir, out, "d")} {
			if _, err := os.Stat(f); err == nil {
				t.Errorf("%s: %s exists", name, filepath.Base(f))
			}
		}
		noTemps(t, dir)
	}
}

func TestPutRecreatesRemovedBuckets(t *testing.T) {
	s, dir := newStore(t)
	id, data := testID(8), []byte("after a cleanup")
	os.RemoveAll(dir)
	os.Mkdir(dir, 0o777)
	put(t, s, id, data)
	var h Hit
	if !s.Get(&id, &h) {
		t.Fatal("miss after put into removed buckets")
	}
}

func TestPutEmptyOutput(t *testing.T) {
	s, dir := newStore(t)
	id := testID(10)
	res := put(t, s, id, nil)
	fi, err := os.Stat(string(res.DiskPath()))
	if err != nil || fi.Size() != 0 || string(res.DiskPath()) != entryFile(dir, sha256.Sum256(nil), "d") {
		t.Fatalf("empty output: %v %v", fi, err)
	}
	var h Hit
	if !s.Get(&id, &h) || h.Size != 0 {
		t.Fatal("miss on empty output")
	}
}

// While a large output is being put, another process looking at its path sees
// nothing or the whole file, never a prefix.
func TestPutNeverExposesPartialOutput(t *testing.T) {
	s, dir := newStore(t)
	data := bytes.Repeat([]byte{0xab}, 64<<20)
	out := sha256.Sum256(data)
	dfile := entryFile(dir, out, "d")
	var wg sync.WaitGroup
	stop := make(chan struct{})
	var bad []int64
	wg.Add(1)
	go func() {
		defer wg.Done()
		var st syscall.Stat_t
		for {
			select {
			case <-stop:
				return
			default:
			}
			if syscall.Stat(dfile, &st) == nil && st.Size != int64(len(data)) {
				bad = append(bad, st.Size)
			}
		}
	}()
	put(t, s, testID(11), data)
	close(stop)
	wg.Wait()
	if len(bad) > 0 {
		t.Fatalf("saw partial output sizes %v", bad[:min(5, len(bad))])
	}
}

func TestNoStore(t *testing.T) {
	for _, dir := range []string{"", "relative/dir", "/bad\xffutf8"} {
		s := Open(dir)
		id := testID(1)
		var h Hit
		if s.Dir() != "" || s.Get(&id, &h) {
			t.Errorf("%q: usable store", dir)
		}
		b := body([]byte("x"))
		out := sha256.Sum256([]byte("x"))
		var res PutResult
		if err := s.Put(&id, &out, true, 1, b, &res); err == nil || !b.consumed() {
			t.Errorf("%q: put err %v consumed %v", dir, err, b.consumed())
		}
	}
}

func sha(b []byte) [hashSize]byte { return sha256.Sum256(b) }

// Several processes (distinct pids, one directory) store the same outputs at
// once, in the same order so their writes overlap: no put may fail, and every
// output ends up whole under its own hash with no temp file left.
func TestConcurrentProcessesPutSameOutputs(t *testing.T) {
	_, dir := newStore(t)
	const procs, outputs = 6, 150
	data := make([][]byte, outputs)
	for i := range data {
		data[i] = bytes.Repeat([]byte{byte(i), byte(i >> 8), 7}, 1000+i*37)
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make(chan error, procs*outputs)
	for p := range procs {
		s := Open(dir)
		s.pid = 1000 + p
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for i, d := range data {
				id := testID(byte(i))
				id[0] ^= byte(p) // distinct actions, shared outputs
				out := sha256.Sum256(d)
				var res PutResult
				if err := s.Put(&id, &out, true, int64(len(d)), body(d), &res); err != nil {
					errs <- err
				}
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("put failed: %v", err)
	}
	noTemps(t, dir)
	for _, d := range data {
		sum := sha256.Sum256(d)
		got, err := os.ReadFile(entryFile(dir, sum, "d"))
		if err != nil || !bytes.Equal(got, d) {
			t.Fatalf("output %x damaged or missing: %v", sum[:4], err)
		}
	}
}
