package daemon

import (
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// The rule's edges: the gap bounds, the boot, the phase and mode, the carried
// window capped at the largest W (7 h 5 min) whatever state.json says, and the
// carried start grace.
func TestFindHandoverRule(t *testing.T) {
	l := evict.Defaults()
	start := simStart
	boot := start.Add(-24*time.Hour).UnixNano() / 1000
	stopped := func(mod func(*ownerstate.State)) ownerstate.State {
		st := ownerstate.State{Version: "0.2.0", CacheDir: "/c", Extra: ownerstate.Extra{
			PID: 42, Phase: PhaseStopped, ModeRequested: ownerstate.ModeOwner, WindowSeconds: int64(5 * time.Hour / time.Second),
			LastWallNs: start.Add(-30 * time.Second).UnixNano(), BootTimeUs: boot,
		}}
		if mod != nil {
			mod(&st)
		}
		return st
	}
	for _, tc := range []struct {
		name   string
		prev   ownerstate.State
		ok     bool
		window time.Duration
	}{
		{"clean-stop", stopped(nil), true, 5 * time.Hour},
		{"gap-exactly-2min", stopped(func(s *ownerstate.State) { s.Extra.LastWallNs = start.Add(-2 * time.Minute).UnixNano() }), true, 5 * time.Hour},
		{"gap-over-2min", stopped(func(s *ownerstate.State) { s.Extra.LastWallNs = start.Add(-2*time.Minute - time.Second).UnixNano() }), false, 0},
		{"stop-after-start", stopped(func(s *ownerstate.State) { s.Extra.LastWallNs = start.Add(time.Second).UnixNano() }), false, 0},
		{"no-wall-clock", stopped(func(s *ownerstate.State) { s.Extra.LastWallNs = 0 }), false, 0},
		{"rebooted", stopped(func(s *ownerstate.State) { s.Extra.BootTimeUs = boot - int64(time.Hour/time.Microsecond) }), false, 0},
		{"boot-unknown", stopped(func(s *ownerstate.State) { s.Extra.BootTimeUs = 0 }), true, 5 * time.Hour},
		{"crashed-while-ready", stopped(func(s *ownerstate.State) { s.Extra.Phase = "ready" }), false, 0},
		{"breaker", stopped(func(s *ownerstate.State) { s.Extra.Phase = PhaseCrashLoop }), false, 0},
		{"observe-before", stopped(func(s *ownerstate.State) { s.Extra.ModeRequested = ownerstate.ModeObserve }), false, 0},
		{"other-cache", stopped(func(s *ownerstate.State) { s.CacheDir = "/other" }), false, 0},
		{"window-over-cap", stopped(func(s *ownerstate.State) { s.Extra.WindowSeconds = 1 << 50 }), true, 7*time.Hour + 5*time.Minute},
		{"window-negative", stopped(func(s *ownerstate.State) { s.Extra.WindowSeconds = -5 }), true, 0},
		{"no-state", ownerstate.State{}, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, ok := findHandover(tc.prev, "/c", boot, start, l)
			if ok != tc.ok || h.window != tc.window {
				t.Fatalf("handover %v window %s, want %v %s", ok, h.window, tc.ok, tc.window)
			}
			if ok && (h.pid != 42 || h.version != "0.2.0") {
				t.Errorf("from pid %d version %q", h.pid, h.version)
			}
		})
	}
	// The grace carried is the stopped run's remainder less the 30 s gap, at most W.
	for _, tc := range []struct{ left, want time.Duration }{
		{0, 0}, {20 * time.Second, 0}, {90 * time.Minute, 90*time.Minute - 30*time.Second}, {5 * time.Hour, l.Window},
	} {
		h, _ := findHandover(stopped(func(s *ownerstate.State) { s.Extra.GraceLeftNs = int64(tc.left) }), "/c", boot, start, l)
		if h.graceLeft != tc.want {
			t.Errorf("grace left %s at the stop carries %s, want %s", tc.left, h.graceLeft, tc.want)
		}
	}
}
