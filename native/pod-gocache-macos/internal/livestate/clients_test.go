package livestate

import (
	"bufio"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// TestMain doubles as a client process for the cross-process tests:
// LIVESTATE_HELPER=claim:<dir> claims a slot, pins one output, prints the
// slot and waits to be killed.
func TestMain(m *testing.M) {
	if v := os.Getenv("LIVESTATE_HELPER"); len(v) > 6 && v[:6] == "claim:" {
		id := testCache
		if named, ok := parseDirName(filepath.Base(v[6:])); ok {
			id = named // a live directory named for its cache
		}
		s, err := ClaimSlot(v[6:], id, BootID(), os.Getppid())
		if err != nil {
			fmt.Println("error", err)
			os.Exit(1)
		}
		out, act := idOf("helper-out"), idOf("helper-act")
		protect(func() { s.Pin(&out, &act, KindHitFast, 10) })
		fmt.Println("slot", (s.off-slotHeadersOffset)/slotHeaderSize)
		select {}
	}
	os.Exit(m.Run())
}

func newClients(t testing.TB) (string, *Clients) {
	t.Helper()
	dir := t.TempDir()
	c, err := OpenClients(dir, testCache, [16]byte{1})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return dir, c
}

func slotIndex(s *Slot) int { return (s.off - slotHeadersOffset) / slotHeaderSize }

func pin(t testing.TB, s *Slot, out, act *[32]byte, kind uint64) bool {
	t.Helper()
	var dying bool
	if !protect(func() { dying = s.Pin(out, act, kind, 1) }) {
		t.Fatal("pin faulted")
	}
	return dying
}

// A client logs each output once per session (puts and flagged hits always),
// and the daemon reads the records back.
func TestPinsReachTheDaemon(t *testing.T) {
	dir, c := newClients(t)
	s, err := ClaimSlot(dir, testCache, [16]byte{1}, 99)
	if err != nil {
		t.Fatal(err)
	}
	o1, o2, a1, a2 := idOf("o1"), idOf("o2"), idOf("a1"), idOf("a2")
	pin(t, s, &o1, &a1, KindHitFast)
	pin(t, s, &o1, &a2, KindHitDisk) // same output: not logged again
	pin(t, s, &o2, &a2, KindHitDisk|RecordStale)
	pin(t, s, &o2, &a2, KindHitDisk|RecordRefreshed) // flagged: logged
	pin(t, s, &o1, &a1, KindPutStored)               // puts always
	i := slotIndex(s)
	var v SlotView
	if !c.Slot(i, &v) || v.Token == 0 || v.GoPID != 99 || v.PID != os.Getpid() || v.LogLen != 4 {
		t.Fatalf("slot view %+v", v)
	}
	recs, ok := c.Records(i, 0, v.LogLen, nil)
	if !ok || len(recs) != 4 {
		t.Fatalf("records %v %v", ok, recs)
	}
	want := []Record{
		{Out: Prefix(&o1), Action: Prefix(&a1), Kind: KindHitFast},
		{Out: Prefix(&o2), Action: Prefix(&a2), Kind: KindHitDisk, Flags: RecordStale},
		{Out: Prefix(&o2), Action: Prefix(&a2), Kind: KindHitDisk, Flags: RecordRefreshed},
		{Out: Prefix(&o1), Action: Prefix(&a1), Kind: KindPutStored},
	}
	for k := range want {
		got := recs[k]
		got.Micros, got.Size = 0, 0
		if got != want[k] {
			t.Errorf("record %d = %+v, want %+v", k, got, want[k])
		}
	}
}

// The log has a fixed size: past it the slot is flagged and nothing faults.
func TestLogOverflow(t *testing.T) {
	dir, c := newClients(t)
	s, err := ClaimSlot(dir, testCache, [16]byte{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	act := idOf("a")
	for k := range LogRecords + 10 {
		var out [32]byte
		out[0], out[1], out[2], out[3] = byte(k), byte(k>>8), byte(k>>16), 1
		pin(t, s, &out, &act, KindHitFast)
	}
	var v SlotView
	c.Slot(slotIndex(s), &v)
	if !s.Overflowed() || v.Flags&FlagOverflow == 0 || v.LogLen != LogRecords {
		t.Fatalf("overflow not flagged: %+v", v)
	}
}

// The dying table: an output in the active batch is dying, others are not,
// and nothing is dying once the batch ends. Prefixes that collide in the
// table are all found.
func TestDyingBatch(t *testing.T) {
	dir, c := newClients(t)
	s, err := ClaimSlot(dir, testCache, [16]byte{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	act := idOf("a")
	var outs [][32]byte
	var prefixes []uint64
	target := dyingSlot(Prefix(ptr(idOf("d0"))))
	for k := 0; len(outs) < 6; k++ {
		o := idOf("d" + strconv.Itoa(k))
		if dyingSlot(Prefix(&o)) == target {
			outs = append(outs, o)
			prefixes = append(prefixes, Prefix(&o))
		}
	}
	other := idOf("alive")
	if !c.BeginDying(prefixes[:5]) {
		t.Fatal("BeginDying")
	}
	for k := range 5 {
		if !pin(t, s, &outs[k], &act, KindHitFast) {
			t.Errorf("dying output %d not seen dying", k)
		}
	}
	if pin(t, s, &outs[5], &act, KindHitFast) || pin(t, s, &other, &act, KindHitFast) {
		t.Error("an output outside the batch is dying")
	}
	c.EndDying()
	if pin(t, s, &outs[0], &act, KindPutPin) {
		t.Error("dying after the batch ended")
	}
	// A new batch never sees entries of the old one.
	c.BeginDying(prefixes[5:])
	if pin(t, s, &outs[1], &act, KindPutPin) || !pin(t, s, &outs[5], &act, KindPutPin) {
		t.Error("batches mixed")
	}
	c.EndDying()
}

// S5: a batch older than BatchLife, or stamped on another boot, is ignored:
// a stopped or dead daemon never turns outputs into misses for long.
func TestStaleBatchIgnored(t *testing.T) {
	dir, c := newClients(t)
	s, err := ClaimSlot(dir, testCache, [16]byte{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall_close(s)
	out, act := idOf("o"), idOf("a")
	c.BeginDying([]uint64{Prefix(&out)})
	if !pin(t, s, &out, &act, KindHitFast) {
		t.Fatal("a fresh batch is not honored")
	}
	for _, start := range []int64{AwakeNow() - int64(BatchLife) - 1, AwakeNow() + int64(time.Hour)} {
		c.hdr.store(chBatchStart, uint64(start))
		if pin(t, s, &out, &act, KindPutPin) {
			t.Errorf("batch started at %d (now %d) still honored", start, AwakeNow())
		}
	}
	c.EndDying()
}

func ptr(id [32]byte) *[32]byte { return &id }

// S2 (b): the handshake. Whatever the interleaving, either the daemon sees
// the pin after publishing the batch, or the client sees the batch after
// publishing its pin. Never neither.
func TestHandshakeNeverMissesBoth(t *testing.T) {
	dir, c := newClients(t)
	act := idOf("act")
	rounds := 3000
	if os.Getenv("POD_GOCACHE_LONG") != "" {
		rounds = 200000
	}
	for r := range rounds {
		s, err := ClaimSlot(dir, testCache, [16]byte{}, 1)
		if err != nil {
			t.Fatal(err)
		}
		var out [32]byte
		out[0], out[1], out[2], out[3], out[4] = byte(r), byte(r>>8), byte(r>>16), byte(r>>24), 0x5a
		p := Prefix(&out)
		i := slotIndex(s)
		var clientSawDying, daemonSawPin atomic.Bool
		var wg sync.WaitGroup
		wg.Add(2)
		spin := rand.IntN(200)
		go func() {
			defer wg.Done()
			for range spin {
			}
			protect(func() { clientSawDying.Store(s.Pin(&out, &act, KindHitFast, 1)) })
		}()
		go func() {
			defer wg.Done()
			for range 200 - spin {
			}
			c.BeginDying([]uint64{p})
			var v SlotView
			c.Slot(i, &v)
			recs, _ := c.Records(i, 0, v.LogLen, nil)
			for _, rec := range recs {
				if rec.Out == p {
					daemonSawPin.Store(true)
				}
			}
		}()
		wg.Wait()
		c.EndDying()
		if !clientSawDying.Load() && !daemonSawPin.Load() {
			t.Fatalf("round %d: the daemon missed the pin and the client missed the batch", r)
		}
		s.Close()
		syscall_close(s)
	}
}

// syscall_close drops a test slot's descriptor (and with it, in this one
// process, every lock: tests claim one slot at a time).
func syscall_close(s *Slot) {
	syscall.Munmap(s.log.b)
	syscall.Munmap(s.hdr.b)
	os.NewFile(uintptr(s.fd), "clients").Close()
}

// S12 and liveness: a slot is held exactly as long as its process lives,
// whatever it left in the header.
func TestSlotLivesWithItsProcess(t *testing.T) {
	dir, c := newClients(t)
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "LIVESTATE_HELPER=claim:"+dir)
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var slot int
	if _, err := fmt.Sscanf(line, "slot %d", &slot); err != nil {
		t.Fatalf("helper said %q", line)
	}
	holder, err := c.Holder(slot)
	if err != nil || holder != cmd.Process.Pid {
		t.Fatalf("holder = %d, %v; want %d", holder, err, cmd.Process.Pid)
	}
	// This process claims another slot, never the helper's.
	s, err := ClaimSlot(dir, testCache, [16]byte{}, 1)
	if err != nil || slotIndex(s) == slot {
		t.Fatalf("claimed %v %v", slotIndex(s), err)
	}
	var v SlotView
	c.Slot(slot, &v)
	recs, _ := c.Records(slot, 0, v.LogLen, nil)
	if len(recs) != 1 || recs[0].Out != Prefix(ptr(idOf("helper-out"))) {
		t.Fatalf("helper's pin not readable: %+v", recs)
	}
	cmd.Process.Kill()
	cmd.Wait()
	deadline := time.Now().Add(5 * time.Second)
	for {
		holder, err = c.Holder(slot)
		if err == nil && holder == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("killed client still holds its slot: %d %v", holder, err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The dead client's header and records are still there; only the lock
	// says it is gone, and a new claim takes the slot over with a new token.
	if !c.Slot(slot, &v) || v.Token == 0 {
		t.Fatal("header vanished")
	}
	syscall_close(s)
}

// An existing clients file is adopted as it is: a restarted daemon keeps the
// slots and records of clients that are still running.
func TestClientsFileAdopted(t *testing.T) {
	dir, c := newClients(t)
	s, err := ClaimSlot(dir, testCache, [16]byte{}, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall_close(s)
	o, a := idOf("o"), idOf("a")
	pin(t, s, &o, &a, KindHitFast)
	c.Close()
	c2, err := OpenClients(dir, testCache, [16]byte{2})
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	if !c2.Adopted {
		t.Fatal("not adopted")
	}
	var v SlotView
	c2.Slot(slotIndex(s), &v)
	recs, _ := c2.Records(slotIndex(s), 0, v.LogLen, nil)
	if len(recs) != 1 || recs[0].Out != Prefix(&o) {
		t.Fatalf("records lost across a daemon restart: %+v", recs)
	}
	// A file for another cache is replaced, never reinterpreted.
	c3, err := OpenClients(dir, CacheID{Dev: 1, Ino: 2}, [16]byte{})
	if err != nil || c3.Adopted {
		t.Fatalf("foreign file adopted: %v", err)
	}
	c3.Close()
	if _, err := os.Stat(filepath.Join(dir, ClientsName)); err != nil {
		t.Fatal(err)
	}
}

func TestPrefixSet(t *testing.T) {
	var s prefixSet
	seen := map[uint64]bool{}
	r := rand.New(rand.NewPCG(1, 2))
	for range 50000 {
		p := r.Uint64() % 30000
		if s.add(p) == seen[p] {
			t.Fatalf("add(%d) disagrees with the map", p)
		}
		seen[p] = true
	}
}

// Gate fix 3: a batch left by a daemon of another boot is ignored, whatever
// its awake-clock age says (the clock restarts at boot); a batch from this
// boot is honored, and so is one from a daemon that wrote no boot.
func TestBatchFromAnotherBootIgnored(t *testing.T) {
	dir, c := newClients(t) // the daemon's boot is {1}
	out, act := idOf("o"), idOf("a")
	c.BeginDying([]uint64{Prefix(&out)})
	defer c.EndDying()
	for _, tc := range []struct {
		name        string
		client      [16]byte
		daemonBoot  bool
		wantHonored bool
	}{
		{"same boot", [16]byte{1}, true, true},
		{"another boot", [16]byte{2}, true, false},
		{"daemon wrote no boot", [16]byte{2}, false, true},
	} {
		if !tc.daemonBoot {
			c.hdr.store(chDaemonBoot, 0)
			c.hdr.store(chDaemonBoot+8, 0)
		}
		s, err := ClaimSlot(dir, testCache, tc.client, 1)
		if err != nil {
			t.Fatal(err)
		}
		if got := pin(t, s, &out, &act, KindPutPin); got != tc.wantHonored {
			t.Errorf("%s: dying %v, want %v", tc.name, got, tc.wantHonored)
		}
	}
}
