package store

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
)

// liveRig is a cache directory with the daemon's side of the shared state
// played by the test: it publishes entries and reads the client's records.
type liveRig struct {
	t     testing.TB
	s     *Store
	dir   string
	idx   *livestate.IndexWriter
	cli   *livestate.Clients
	live  *livestate.Client
	cache livestate.CacheID
}

func newLiveRig(t testing.TB) *liveRig {
	t.Helper()
	s, dir := newStore(t)
	root := t.TempDir()
	t.Setenv(livestate.EnvRoot, root)
	id, ok := livestate.StatCache(dir)
	if !ok {
		t.Fatal("stat cache")
	}
	ld := livestate.Dir(root, id)
	if err := os.MkdirAll(ld, 0o700); err != nil {
		t.Fatal(err)
	}
	r := &liveRig{t: t, s: s, dir: dir, cache: id}
	var err error
	if r.cli, err = livestate.OpenClients(ld, id, livestate.BootID()); err != nil {
		t.Fatal(err)
	}
	if r.idx, err = livestate.CreateIndex(ld, id, 1<<12, 1, livestate.BootID()); err != nil {
		t.Fatal(err)
	}
	r.live = livestate.OpenClient(dir, 1)
	if r.live.Index != livestate.ReasonOK || r.live.Pins != livestate.ReasonOK {
		t.Fatalf("client did not open the shared state: index %v pins %v", r.live.Index, r.live.Pins)
	}
	s.SetLive(r.live)
	t.Cleanup(func() { r.idx.Close(); r.cli.Close() })
	return r
}

// publish reads the -a file the way the daemon does and publishes it.
func (r *liveRig) publish(id [hashSize]byte) {
	r.t.Helper()
	apath := entryFile(r.dir, id, "a")
	var st syscall.Stat_t
	if err := syscall.Stat(apath, &st); err != nil {
		r.t.Fatal(err)
	}
	data, err := os.ReadFile(apath)
	if err != nil {
		r.t.Fatal(err)
	}
	out, size, tm, ok := ParseEntry(append(data, 0)[:len(data)], &id)
	if !ok {
		r.t.Fatalf("unparsable -a %q", data)
	}
	e := livestate.Entry{Output: out, Size: size, Time: tm, Ino: st.Ino, Ctime: st.Ctimespec.Nano(), Mtime: st.Mtimespec.Nano()}
	if !r.idx.Put(&id, &e) {
		r.t.Fatal("publish refused")
	}
}

func (r *liveRig) records() []livestate.Record {
	r.t.Helper()
	for i := range livestate.SlotCount {
		var v livestate.SlotView
		if r.cli.Slot(i, &v) && v.Token != 0 && v.PID == os.Getpid() && v.ClosedMono == 0 {
			recs, _ := r.cli.Records(i, 0, v.LogLen, nil)
			return recs
		}
	}
	r.t.Fatal("no slot of this process")
	return nil
}

func (r *liveRig) get(id [hashSize]byte) (Hit, bool) {
	var h Hit
	ok := r.s.Get(&id, &h)
	return h, ok
}

// A published entry whose -a file is unchanged is served from the index,
// exactly as reading the file would serve it.
func TestFastHit(t *testing.T) {
	r := newLiveRig(t)
	id := sha256.Sum256([]byte("action"))
	data := []byte("compiled package")
	put(t, r.s, id, data)
	r.publish(id)
	h, ok := r.get(id)
	if !ok || !h.Fast {
		t.Fatalf("hit=%v fast=%v", ok, h.Fast)
	}
	disk := Open(r.dir) // S1 alone, as the reference
	var want Hit
	if !disk.Get(&id, &want) || want.OutputID != h.OutputID || want.Size != h.Size || want.Time != h.Time || string(want.DiskPath()) != string(h.DiskPath()) {
		t.Fatalf("fast hit differs from the disk read: %+v vs %+v", h, want)
	}
	if r.live.Fast != 1 {
		t.Fatalf("fast count %d", r.live.Fast)
	}
}

// S3/B2: an -a rewritten after it was published (go test rewrites its -a
// on every run) is read from disk at once: the new content is served, never
// the published one.
func TestRewrittenEntryNeverServedStale(t *testing.T) {
	r := newLiveRig(t)
	id := sha256.Sum256([]byte("test action"))
	put(t, r.s, id, []byte("run 1 output"))
	r.publish(id)
	for run := 2; run <= 50; run++ {
		data := []byte("run output " + string(rune('A'+run)))
		put(t, r.s, id, data) // same size each time, new output ID and time
		h, ok := r.get(id)
		if !ok || h.OutputID != sha256.Sum256(data) {
			t.Fatalf("run %d: served %x, want the rewritten entry", run, h.OutputID[:4])
		}
		if h.Fast {
			t.Fatalf("run %d: a rewritten entry came from the index", run)
		}
	}
	if r.live.Stale == 0 {
		t.Fatal("stale entries not counted")
	}
	// Each stale hit asks the daemon to re-read the -a.
	stale := 0
	for _, rec := range r.records() {
		if rec.Flags&livestate.RecordStale != 0 {
			stale++
		}
	}
	if stale == 0 {
		t.Fatal("no stale record for the daemon")
	}
}

// B2: an entry the index lacks is not a miss; an -a that is gone is.
func TestIndexMissFallsBackToDisk(t *testing.T) {
	r := newLiveRig(t)
	id := sha256.Sum256([]byte("unpublished"))
	put(t, r.s, id, []byte("x"))
	if h, ok := r.get(id); !ok || h.Fast {
		t.Fatalf("unpublished entry: hit=%v fast=%v", ok, h.Fast)
	}
	r.publish(id)
	os.Remove(entryFile(r.dir, id, "a"))
	if _, ok := r.get(id); ok {
		t.Fatal("hit for a deleted -a")
	}
}

// S24: 0-byte outputs and executable directories through the fast path.
func TestFastPathEntryShapes(t *testing.T) {
	r := newLiveRig(t)
	empty := sha256.Sum256([]byte("empty"))
	put(t, r.s, empty, nil)
	r.publish(empty)
	if h, ok := r.get(empty); !ok || !h.Fast || h.Size != 0 {
		t.Fatalf("0-byte output: hit=%v fast=%v size=%d", ok, h.Fast, h.Size)
	}
	// An executable entry as go run writes it: -d is a directory with one file.
	exe := sha256.Sum256([]byte("go run"))
	prog := []byte("#!binary")
	out := sha256.Sum256(prog)
	dpath := entryFile(r.dir, out, "d")
	os.MkdirAll(dpath, 0o777)
	os.WriteFile(filepath.Join(dpath, "prog"), prog, 0o755)
	if err := r.s.writeEntry(&exe, &out, int64(len(prog)), time.Now().UnixNano()); err != nil {
		t.Fatal(err)
	}
	r.publish(exe)
	h, ok := r.get(exe)
	if !ok || !h.Fast || string(h.DiskPath()) != filepath.Join(dpath, "prog") {
		t.Fatalf("executable: hit=%v fast=%v path=%s", ok, h.Fast, h.DiskPath())
	}
}

// B3: the client itself refreshes an hour-old mtime on -a and -d, on the
// fast path too, and tells the daemon it did.
func TestFastPathKeepsMarkUsed(t *testing.T) {
	r := newLiveRig(t)
	id := sha256.Sum256([]byte("old"))
	data := []byte("old output")
	put(t, r.s, id, data)
	out := sha256.Sum256(data)
	old := time.Now().Add(-3 * time.Hour)
	apath, dpath := entryFile(r.dir, id, "a"), entryFile(r.dir, out, "d")
	os.Chtimes(apath, old, old)
	os.Chtimes(dpath, old, old)
	r.publish(id)
	if h, ok := r.get(id); !ok || !h.Fast {
		t.Fatalf("hit=%v fast=%v", ok, h.Fast)
	}
	for _, p := range []string{apath, dpath} {
		fi, _ := os.Stat(p)
		if time.Since(fi.ModTime()) > time.Minute {
			t.Errorf("%s mtime not refreshed: %v", filepath.Base(p), fi.ModTime())
		}
	}
	refreshed := false
	for _, rec := range r.records() {
		refreshed = refreshed || rec.Flags&livestate.RecordRefreshed != 0
	}
	if !refreshed {
		t.Error("the daemon was not told about the refresh")
	}
}

// S2: an output the daemon is deleting is answered as a miss; once the batch
// ends it is a hit again.
func TestDyingOutputIsAMiss(t *testing.T) {
	r := newLiveRig(t)
	id := sha256.Sum256([]byte("victim"))
	data := []byte("victim output")
	put(t, r.s, id, data)
	r.publish(id)
	out := sha256.Sum256(data)
	if !r.cli.BeginDying([]uint64{livestate.Prefix(&out)}) {
		t.Fatal("BeginDying")
	}
	if _, ok := r.get(id); ok {
		t.Fatal("hit on a dying output")
	}
	if r.live.DyingMisses != 1 {
		t.Fatalf("dying misses %d", r.live.DyingMisses)
	}
	r.cli.EndDying()
	if _, ok := r.get(id); !ok {
		t.Fatal("miss after the batch ended")
	}
}

// A put of an output the daemon is deleting writes it again instead of
// reusing it, and the result is in place afterwards.
func TestPutBesideDyingOutput(t *testing.T) {
	r := newLiveRig(t)
	data := []byte("shared output bytes")
	out := sha256.Sum256(data)
	put(t, r.s, sha256.Sum256([]byte("first")), data)
	dpath := entryFile(r.dir, out, "d")
	var before syscall.Stat_t
	syscall.Stat(dpath, &before)
	r.cli.BeginDying([]uint64{livestate.Prefix(&out)})
	// The daemon's unlink lands while the put waits on link(2).
	go func() {
		time.Sleep(2 * time.Millisecond)
		os.Remove(dpath)
	}()
	res := put(t, r.s, sha256.Sum256([]byte("second")), data)
	r.cli.EndDying()
	if res.Outcome != Stored {
		t.Fatalf("outcome %v, want Stored (written again)", res.Outcome)
	}
	var after syscall.Stat_t
	if err := syscall.Stat(dpath, &after); err != nil {
		t.Fatalf("output missing after the put: %v", err)
	}
	if after.Ino == before.Ino {
		t.Fatal("the dying inode was reused")
	}
	if got, _ := os.ReadFile(dpath); string(got) != string(data) {
		t.Fatal("wrong content")
	}
	noTemps(t, r.dir)
	if r.live.DyingPuts != 1 {
		t.Fatalf("dying puts %d", r.live.DyingPuts)
	}
}

// Puts are logged after their -a is written; hits once per output.
func TestRecordsForHitsAndPuts(t *testing.T) {
	r := newLiveRig(t)
	a1, a2 := sha256.Sum256([]byte("a1")), sha256.Sum256([]byte("a2"))
	data := []byte("same output")
	put(t, r.s, a1, data)
	put(t, r.s, a2, data) // existing output: pinned before reuse, logged after
	r.get(a1)
	r.get(a2)
	var kinds []uint8
	for _, rec := range r.records() {
		kinds = append(kinds, rec.Kind)
	}
	want := []uint8{livestate.KindPutStored, livestate.KindPutPin, livestate.KindPutExisting}
	if len(kinds) < len(want) {
		t.Fatalf("records %v", kinds)
	}
	for k := range want {
		if kinds[k] != want[k] {
			t.Fatalf("records %v, want prefix %v", kinds, want)
		}
	}
	if len(kinds) != len(want) {
		t.Fatalf("hits of an output already pinned were logged again: %v", kinds)
	}
}

// BenchmarkGetPaths is a get's own cost on each path, in process (no pipe):
// S1 reading the -a file, S9 from the index, and S9 when the index is stale.
// The stale path costs what S1 costs plus the index lookup and the stat that
// found it stale, never a second read.
func BenchmarkGetPaths(b *testing.B) {
	r := newLiveRig(b)
	const n = 2000
	ids := make([][hashSize]byte, n)
	for i := range ids {
		ids[i] = sha256.Sum256([]byte{byte(i), byte(i >> 8), 'a'})
		put(b, r.s, ids[i], []byte{byte(i), byte(i >> 8), 'd'})
	}
	s1 := Open(r.dir)
	loop := func(b *testing.B, s *Store, fast bool) {
		var h Hit
		i := 0
		for b.Loop() {
			if !s.Get(&ids[i%n], &h) || h.Fast != fast {
				b.Fatalf("hit %v fast %v", h, fast)
			}
			i++
		}
	}
	b.Run("s1", func(b *testing.B) { loop(b, s1, false) })
	for _, id := range ids {
		r.publish(id)
	}
	b.Run("s9-fast", func(b *testing.B) { loop(b, r.s, true) })
	for i := range ids {
		os.Chtimes(entryFile(r.dir, ids[i], "a"), time.Now(), time.Now()) // new ctime: every entry stale
	}
	b.Run("s9-stale", func(b *testing.B) { loop(b, r.s, false) })
}

// Gate fix 9: the real Get against the real clients file, with the daemon's
// side of the dying handshake (publish the batch, drain the slot, unlink
// unless pinned, end the batch) injected at every point around the pin:
// before the get, before the pin, after the pin, after the get. Every get
// either misses or its -d is still there after the daemon is done.
func TestDyingHandshakeAtEveryPoint(t *testing.T) {
	r := newLiveRig(t)
	id := sha256.Sum256([]byte("contested"))
	data := []byte("contested output")
	out := sha256.Sum256(data)
	dpath := entryFile(r.dir, out, "d")
	const before, beforePin, afterPin, after = 0, hookBeforePin, hookAfterPin, 3
	points := []int{before, beforePin, afterPin, after}
	defer func() { testHook = nil }()
	hits, misses, unlinked := 0, 0, 0
	for _, pb := range points {
		for _, pu := range points {
			for _, pe := range points {
				if pu < pb || pe < pu {
					continue
				}
				// A fresh session, so the output is not pinned yet.
				r.live.Close()
				r.live = livestate.OpenClient(r.dir, 1)
				r.s.SetLive(r.live)
				put(t, Open(r.dir), id, data) // written by another go process
				r.publish(id)
				decided, removed := false, false
				daemon := func(p int) {
					if p == pb {
						if !r.cli.BeginDying([]uint64{livestate.Prefix(&out)}) {
							t.Fatal("BeginDying")
						}
						pinned := false
						for _, rec := range r.records() {
							pinned = pinned || rec.Out == livestate.Prefix(&out)
						}
						decided = !pinned
					}
					if p == pu && decided {
						removed = os.Remove(dpath) == nil
					}
					if p == pe {
						r.cli.EndDying()
					}
				}
				testHook = daemon
				daemon(before)
				h, ok := r.get(id)
				daemon(after)
				testHook = nil
				if removed {
					unlinked++
				}
				switch {
				case !ok:
					misses++
				case removed:
					t.Errorf("begin/unlink/end at %d/%d/%d: hit on %s, which the daemon then unlinked", pb, pu, pe, filepath.Base(dpath))
				default:
					hits++
					if _, err := os.Stat(string(h.DiskPath())); err != nil {
						t.Errorf("begin/unlink/end at %d/%d/%d: hit whose -d is gone: %v", pb, pu, pe, err)
					}
				}
			}
		}
	}
	if hits == 0 || misses == 0 || unlinked == 0 {
		t.Errorf("not every outcome happened: %d hits, %d misses, %d unlinks", hits, misses, unlinked)
	}
	t.Logf("%d hits, %d misses, %d unlinks", hits, misses, unlinked)
}
