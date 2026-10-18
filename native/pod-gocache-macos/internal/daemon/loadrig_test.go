package daemon

import (
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

// NOTICED 1 of S9 on a CPU-loaded rig (POD_GOCACHE_LOADRIG=1): busy threads
// at normal priority, three per core, and a daemon at real thread priority
// indexing 20k entries. With the loop pinned to the background band (the
// rule before), indexing waits on the burners; leaving the band after
// lagIndexTicks lets it finish. Both times are logged; the fix must finish
// and not be slower.
func TestLoadRigIndexesOutOfTheBand(t *testing.T) {
	if os.Getenv("POD_GOCACHE_LOADRIG") != "1" {
		t.Skip("set POD_GOCACHE_LOADRIG=1 to load every core for a few minutes")
	}
	cache := tempDir(t)
	for range 20_000 {
		putEntry(t, cache, 100, 3*time.Hour)
	}
	var stop atomic.Bool
	defer stop.Store(true)
	for range 3 * runtime.NumCPU() {
		go func() {
			runtime.LockOSThread()
			x := 0
			for !stop.Load() {
				x++
			}
			_ = x
		}()
	}
	time.Sleep(time.Second)
	measure := func(lag int) time.Duration {
		saved := lagIndexTicks
		lagIndexTicks = lag
		defer func() { lagIndexTicks = saved }()
		cfg := fastConfig(t, cache, 60_000_000_000)
		cfg.Tick, cfg.ScanBudget, cfg.LiveRoot = 200*time.Millisecond, 100*time.Millisecond, "off"
		cfg.Prio = ThreadPriority{}
		start := time.Now()
		stopRun := startRun(t, cfg)
		defer stopRun()
		waitFor(t, 10*time.Minute, "indexing under load", func() bool { return readState(t, cfg.StateDir).Extra.Phase == "ready" })
		return time.Since(start)
	}
	band := measure(1 << 30)
	fixed := measure(15)
	t.Logf("20k entries indexed under %d busy threads: %s in the background band, %s leaving it after 15 ticks", 3*runtime.NumCPU(), band.Round(time.Millisecond), fixed.Round(time.Millisecond))
	if fixed > band {
		t.Errorf("leaving the band was slower: %s against %s", fixed, band)
	}
}
