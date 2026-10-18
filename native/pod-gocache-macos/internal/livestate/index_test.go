package livestate

import (
	"crypto/sha256"
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

var testCache = CacheID{Dev: 7, Ino: 42}

func idOf(s string) [32]byte { return sha256.Sum256([]byte(s)) }

// entryFor derives every field from (id, version), so a reader can tell a
// consistent entry from one mixed out of two writes.
func entryFor(id *[32]byte, v uint64) Entry {
	e := Entry{Size: int64(v), Time: int64(v) * 3, Ino: v + 11, Ctime: int64(v) * 5, Mtime: int64(v) * 7}
	h := sha256.New()
	h.Write(id[:])
	binary.Write(h, binary.LittleEndian, v)
	copy(e.Output[:], h.Sum(nil))
	return e
}

func newIndex(t testing.TB, slots int) (string, *IndexWriter) {
	t.Helper()
	dir := t.TempDir()
	w, err := CreateIndex(dir, testCache, slots, 1, [16]byte{1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return dir, w
}

func lookup(t testing.TB, x *Index, id *[32]byte) (Entry, Result) {
	t.Helper()
	var e Entry
	var r Result
	if !protect(func() { r = x.Lookup(id, &e) }) {
		t.Fatal("lookup faulted")
	}
	return e, r
}

// Every word clients and the daemon share is read and written atomically,
// which needs 8-byte alignment of each offset (mappings are page-aligned).
func TestSharedFieldsAligned(t *testing.T) {
	offsets := map[string]int{
		"ihVersion": ihVersion, "ihHeaderSize": ihHeaderSize, "ihFileSize": ihFileSize, "ihSlots": ihSlots,
		"ihSlotSize": ihSlotSize, "ihCacheDev": ihCacheDev, "ihCacheIno": ihCacheIno, "ihSeed": ihSeed,
		"ihGeneration": ihGeneration, "ihDaemonPID": ihDaemonPID, "ihCreated": ihCreated, "ihSuperseded": ihSuperseded,
		"ihLive": ihLive, "ihBootID": ihBootID, "idxHeaderSize": idxHeaderSize, "idxSlotSize": idxSlotSize,
		"chVersion": chVersion, "chFileSize": chFileSize, "chSlots": chSlots, "chSlotHeadersOffset": chSlotHeadersOffset,
		"chSlotHeaderSize": chSlotHeaderSize, "chLogsOffset": chLogsOffset, "chLogRecords": chLogRecords,
		"chRecordSize": chRecordSize, "chDyingOffset": chDyingOffset, "chDyingEntries": chDyingEntries,
		"chCacheDev": chCacheDev, "chCacheIno": chCacheIno, "chCreated": chCreated, "chBootID": chBootID,
		"chDaemonPID": chDaemonPID, "chDaemonStart": chDaemonStart, "chHeartbeat": chHeartbeat, "chActiveGen": chActiveGen,
		"chBatchStart": chBatchStart, "chDaemonBoot": chDaemonBoot,
		"dyingOffset": dyingOffset, "dyingEntrySize": dyingEntrySize, "slotHeadersOffset": slotHeadersOffset,
		"slotHeaderSize": slotHeaderSize, "logsOffset": logsOffset, "recordSize": recordSize,
		"shPID": shPID, "shGoPID": shGoPID, "shClaimMono": shClaimMono, "shClaimWall": shClaimWall,
		"shClosedMono": shClosedMono, "shLogLen": shLogLen, "shFlags": shFlags, "shBootID": shBootID,
		"shCacheDev": shCacheDev, "shCacheIno": shCacheIno, "shFastHits": shFastHits, "shDiskHits": shDiskHits,
		"shMisses": shMisses, "shPuts": shPuts, "shReason": shReason,
	}
	for name, off := range offsets {
		if off%8 != 0 {
			t.Errorf("%s = %d is not 8-byte aligned", name, off)
		}
	}
	if (isMtime+1)*8 > idxSlotSize || shReason+8 > slotHeaderSize || chDaemonBoot+16 > cliHeaderSize {
		t.Error("a field runs past its block")
	}
	if dyingOffset+dyingEntries*dyingEntrySize > slotHeadersOffset || slotHeadersOffset+SlotCount*slotHeaderSize > logsOffset {
		t.Error("clients file blocks overlap")
	}
	if logsOffset%pageSize != 0 || logSize%pageSize != 0 || idxHeaderSize%pageSize != 0 {
		t.Error("mapped regions must start on page boundaries")
	}
}

func TestIndexRoundTrip(t *testing.T) {
	dir, w := newIndex(t, idxMinSlots)
	x, err := OpenIndex(dir, testCache)
	if err != nil {
		t.Fatal(err)
	}
	defer x.Close()
	a, b, missing := idOf("a"), idOf("b"), idOf("missing")
	ea, eb := entryFor(&a, 1), entryFor(&b, 2)
	ea.Size = 0 // a 0-byte output is a valid entry, not an empty slot
	if !w.Put(&a, &ea) || !w.Put(&b, &eb) {
		t.Fatal("put refused")
	}
	if got, r := lookup(t, x, &a); r != Found || got != ea {
		t.Fatalf("a: %v %+v", r, got)
	}
	if _, r := lookup(t, x, &missing); r == Found {
		t.Fatal("an ID never published was found")
	}
	eb2 := entryFor(&b, 3)
	w.Put(&b, &eb2)
	if got, r := lookup(t, x, &b); r != Found || got != eb2 {
		t.Fatalf("updated b: %v %+v", r, got)
	}
	w.Delete(&a)
	if _, r := lookup(t, x, &a); r == Found {
		t.Fatal("deleted entry still found")
	}
	w.Put(&a, &ea)
	if got, r := lookup(t, x, &a); r != Found || got != ea {
		t.Fatal("re-published entry not found")
	}
}

// S1: IDs that share their first 8 bytes and their probe chain are told apart
// by all 32 bytes, also across deletions in the middle of the chain.
func TestIndexCollidingIDs(t *testing.T) {
	dir := t.TempDir()
	const seed = 0x1234
	w, err := createIndex(dir, testCache, idxMinSlots, 1, [16]byte{}, seed)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	mask := uint64(idxMinSlots - 1)
	base := idOf("base")
	target := hashID(&base, seed) & mask
	var ids [][32]byte
	for i := 0; len(ids) < 24; i++ {
		id := base
		binary.LittleEndian.PutUint64(id[8:], uint64(i))
		binary.LittleEndian.PutUint64(id[16:], uint64(i)*7919)
		if hashID(&id, seed)&mask == target {
			ids = append(ids, id)
		}
	}
	for i := range ids {
		e := entryFor(&ids[i], uint64(i+1))
		if !w.Put(&ids[i], &e) {
			t.Fatalf("put %d refused", i)
		}
	}
	for _, i := range []int{3, 10, 17} {
		w.Delete(&ids[i])
	}
	x, err := OpenIndex(dir, testCache)
	if err != nil {
		t.Fatal(err)
	}
	defer x.Close()
	for i := range ids {
		got, r := lookup(t, x, &ids[i])
		deleted := i == 3 || i == 10 || i == 17
		switch {
		case deleted && r == Found:
			t.Errorf("deleted %d found", i)
		case !deleted && (r != Found || got != entryFor(&ids[i], uint64(i+1))):
			t.Errorf("id %d: %v %+v", i, r, got)
		}
	}
	// Same prefix and chain, never published.
	stranger := base
	stranger[31] ^= 0xff
	if _, r := lookup(t, x, &stranger); r == Found {
		t.Error("a stranger sharing the chain was found")
	}
}

// S1: a slot left mid-write (the daemon stopped between its two sequence
// stores) gives up after bounded retries instead of spinning or serving it.
func TestIndexSlotLeftMidWrite(t *testing.T) {
	dir, w := newIndex(t, idxMinSlots)
	id := idOf("half")
	e := entryFor(&id, 1)
	w.Put(&id, &e)
	slot := w.where[id]
	off := idxHeaderSize + int(slot)*idxSlotSize
	protect(func() { w.r.store(off+8*isSeq, w.r.load(off+8*isSeq)|1) })
	x, err := OpenIndex(dir, testCache)
	if err != nil {
		t.Fatal(err)
	}
	defer x.Close()
	done := make(chan Result, 1)
	go func() {
		_, r := lookup(t, x, &id)
		done <- r
	}()
	select {
	case r := <-done:
		if r != Unsure {
			t.Fatalf("lookup of a slot mid-write = %v, want Unsure (disk fallback)", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("lookup spins on a slot mid-write")
	}
}

// S1: readers racing a writer that rewrites, deletes and re-inserts the same
// keys never see a mix of two versions: every Found entry is consistent.
func TestIndexNoTornReads(t *testing.T) {
	dir, w := newIndex(t, idxMinSlots)
	const keys = 64
	ids := make([][32]byte, keys)
	for i := range ids {
		ids[i] = idOf(string(rune('A' + i)))
		e := entryFor(&ids[i], 1)
		w.Put(&ids[i], &e)
	}
	x, err := OpenIndex(dir, testCache)
	if err != nil {
		t.Fatal(err)
	}
	defer x.Close()
	dur := 400 * time.Millisecond
	if os.Getenv("POD_GOCACHE_LONG") != "" {
		dur = 60 * time.Second
	}
	var stop atomic.Bool
	var lookups, found, torn atomic.Int64
	var wg sync.WaitGroup
	for g := range max(2, runtime.NumCPU()-1) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var e Entry
			n, f := int64(0), int64(0)
			for i := g; !stop.Load(); i++ {
				id := &ids[i%keys]
				var r Result
				protect(func() { r = x.Lookup(id, &e) })
				n++
				if r != Found {
					continue
				}
				f++
				if v := uint64(e.Size); e != entryFor(id, v) {
					torn.Add(1)
				}
			}
			lookups.Add(n)
			found.Add(f)
		}()
	}
	deadline := time.Now().Add(dur)
	for v := uint64(2); time.Now().Before(deadline); v++ {
		for i := range ids {
			if v%7 == 0 && i%3 == 0 {
				w.Delete(&ids[i])
				continue
			}
			e := entryFor(&ids[i], v)
			w.Put(&ids[i], &e)
		}
	}
	stop.Store(true)
	wg.Wait()
	t.Logf("%d lookups, %d found", lookups.Load(), found.Load())
	if torn.Load() != 0 {
		t.Fatalf("%d torn entries served", torn.Load())
	}
	if found.Load() == 0 {
		t.Fatal("no lookup succeeded: the test proves nothing")
	}
}

// S6: a mapping whose file shrinks under it faults; the fault is recovered,
// including inside copy() from the mapping.
func TestFaultsAreRecovered(t *testing.T) {
	dir, w := newIndex(t, idxMinSlots)
	id := idOf("x")
	e := entryFor(&id, 9)
	w.Put(&id, &e)
	x, err := OpenIndex(dir, testCache)
	if err != nil {
		t.Fatal(err)
	}
	defer x.Close()
	if err := os.Truncate(filepath.Join(dir, IndexName), 0); err != nil {
		t.Fatal(err)
	}
	var r Result
	if protect(func() { r = x.Lookup(&id, &e) }) {
		t.Fatalf("lookup on a truncated file did not fault (got %v)", r)
	}
	buf := make([]byte, 4096)
	if protect(func() { copy(buf, x.r.b[idxHeaderSize:]) }) {
		t.Fatal("copy from a truncated mapping did not fault")
	}
	c := &Client{idx: x, Index: ReasonOK}
	if c.Lookup(&id, &e) {
		t.Fatal("client served from a truncated index")
	}
	if c.Index != ReasonFault || c.idx != nil {
		t.Fatalf("client kept a faulting index: %v", c.Index)
	}
	if c.Lookup(&id, &e) {
		t.Fatal("client served after dropping the index")
	}
}

// S14: anything but our own valid index for this cache is refused, and a FIFO
// does not block the open.
func TestOpenIndexRefuses(t *testing.T) {
	good := func(t *testing.T) (string, string) {
		dir, w := newIndex(t, idxMinSlots)
		w.Close()
		return dir, filepath.Join(dir, IndexName)
	}
	patch := func(path string, off int64, v uint64) {
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		var b [8]byte
		binary.LittleEndian.PutUint64(b[:], v)
		f.WriteAt(b[:], off)
		f.Close()
	}
	cases := map[string]func(t *testing.T) string{
		"wrong magic": func(t *testing.T) string {
			dir, p := good(t)
			patch(p, ihMagic, 0x4242)
			return dir
		},
		"newer version": func(t *testing.T) string {
			dir, p := good(t)
			patch(p, ihVersion, Version+1)
			return dir
		},
		"older version": func(t *testing.T) string {
			dir, p := good(t)
			patch(p, ihVersion, Version-1)
			return dir
		},
		"other cache": func(t *testing.T) string {
			dir, p := good(t)
			patch(p, ihCacheIno, testCache.Ino+1)
			return dir
		},
		"header claims more slots": func(t *testing.T) string {
			dir, p := good(t)
			patch(p, ihSlots, idxMinSlots*2)
			return dir
		},
		"shorter than its header says": func(t *testing.T) string {
			dir, p := good(t)
			os.Truncate(p, idxHeaderSize+idxMinSlots*idxSlotSize-pageSize)
			return dir
		},
		"mode 0666": func(t *testing.T) string {
			dir, p := good(t)
			os.Chmod(p, 0o666)
			return dir
		},
		"symlink": func(t *testing.T) string {
			dir, p := good(t)
			os.Rename(p, p+".real")
			os.Symlink(p+".real", p)
			return dir
		},
		"directory": func(t *testing.T) string {
			dir := t.TempDir()
			os.Mkdir(filepath.Join(dir, IndexName), 0o700)
			return dir
		},
		"fifo": func(t *testing.T) string {
			dir := t.TempDir()
			syscall.Mkfifo(filepath.Join(dir, IndexName), 0o600)
			return dir
		},
		"empty": func(t *testing.T) string {
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, IndexName), nil, 0o600)
			return dir
		},
		"10 GB sparse": func(t *testing.T) string {
			dir := t.TempDir()
			f, _ := os.OpenFile(filepath.Join(dir, IndexName), os.O_CREATE|os.O_RDWR, 0o600)
			f.Truncate(10 << 30)
			f.Close()
			return dir
		},
	}
	for name, mk := range cases {
		t.Run(name, func(t *testing.T) {
			dir := mk(t)
			done := make(chan error, 1)
			go func() {
				x, err := OpenIndex(dir, testCache)
				if err == nil {
					x.Close()
				}
				done <- err
			}()
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("accepted")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("open blocked")
			}
		})
	}
}

// A rebuilt index supersedes the old one; a client moves over on its next
// lookup.
func TestClientFollowsRebuild(t *testing.T) {
	dir, w := newIndex(t, idxMinSlots)
	a := idOf("a")
	ea := entryFor(&a, 1)
	w.Put(&a, &ea)
	x, err := OpenIndex(dir, testCache)
	if err != nil {
		t.Fatal(err)
	}
	c := &Client{dir: dir, id: testCache, idx: x}
	defer c.Close()
	var got Entry
	if !c.Lookup(&a, &got) || got != ea {
		t.Fatal("first lookup")
	}
	w2, err := CreateIndex(dir, testCache, idxMinSlots*2, 2, [16]byte{1})
	if err != nil {
		t.Fatal(err)
	}
	defer w2.Close()
	ea2 := entryFor(&a, 2)
	w2.Put(&a, &ea2)
	if !c.Lookup(&a, &got) || got != ea2 {
		t.Fatalf("client did not move to the rebuilt index: %+v", got)
	}
}

// Gate fix 10: the informational live count is written once per publishing
// round (SyncLive), not on every put and delete.
func TestLiveCountWrittenOncePerRound(t *testing.T) {
	w, err := CreateIndex(t.TempDir(), testCache, idxMinSlots, 1, [16]byte{})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	for i := range 10 {
		id := idOf("live" + string(rune('a'+i)))
		w.Put(&id, &Entry{Size: 1})
	}
	if got := w.r.load(ihLive); got != 0 {
		t.Fatalf("live count %d written before the round ended", got)
	}
	w.SyncLive()
	if got := w.r.load(ihLive); got != 10 {
		t.Fatalf("live count %d after the round, want 10", got)
	}
	id := idOf("livea")
	w.Delete(&id)
	w.SyncLive()
	if got := w.r.load(ihLive); got != 9 {
		t.Fatalf("live count %d after a delete, want 9", got)
	}
}
