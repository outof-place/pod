package daemon

import (
	"fmt"
	"testing"
	"time"
)

// A daemon that stops releases the shared files and the publisher lock, so
// the next daemon on the cache publishes (and may delete) at once, also when
// it runs in the same process, as Pod's tests and the realgo harness do.
func TestRestartedDaemonPublishes(t *testing.T) {
	cache, live := tempDir(t), tempDir(t)
	for range 20 {
		putEntry(t, cache, 1000, time.Hour)
	}
	for round := range 2 {
		cfg := fastConfig(t, cache, 60_000_000_000)
		cfg.LiveRoot = live
		setMode(t, cfg.StateDir, "owner")
		stop := startRun(t, cfg)
		waitFor(t, time.Minute, fmt.Sprintf("daemon %d to publish", round+1), func() bool {
			l := readState(t, cfg.StateDir).Extra.Live
			return l != nil && l.Reason == "" && l.Entries == 20
		})
		if code := stop(); code != ExitOK {
			t.Fatalf("round %d: exit %d", round, code)
		}
	}
}
