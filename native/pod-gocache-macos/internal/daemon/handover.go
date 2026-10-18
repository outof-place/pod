package daemon

import (
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// handoverGap is the longest stop-to-start gap (wall clock) still taken for a
// handover; launchd's bootout and bootstrap of a Pod update take seconds.
const handoverGap = 2 * time.Minute

// handover is a clean stop, moments before this start, of a daemon asked to
// own the same cache on the same boot: a Pod update or a reinstall. The new
// daemon keeps only what is left of the stopped run's start grace, and keeps
// its window for ExitGrace, so the go processes that run saw exit still count.
type handover struct {
	pid       int
	version   string
	window    time.Duration // the stopped run's W, capped at the largest W
	graceLeft time.Duration // the stopped run's start grace left, less the gap
	gap       time.Duration
}

// findHandover applies the rule to the state.json the previous run left. A
// crash or SIGKILL (no "stopped" phase), the breaker, an observe run, another
// cache, a reboot or a gap outside [0, handoverGap] is no handover.
func findHandover(prev ownerstate.State, cacheDir string, boot int64, start time.Time, l evict.Limits) (handover, bool) {
	x := prev.Extra
	gap := time.Duration(start.UnixNano() - x.LastWallNs)
	if x.Phase != PhaseStopped || x.ModeRequested != ownerstate.ModeOwner || prev.CacheDir != cacheDir ||
		rebooted(x.BootTimeUs, boot) || x.LastWallNs == 0 || gap < 0 || gap > handoverGap {
		return handover{}, false
	}
	maxW := evict.ProcessWindow(l, l.ProcessAgeCap)
	w := time.Duration(min(max(x.WindowSeconds, 0), int64(maxW/time.Second))) * time.Second
	grace := min(max(time.Duration(x.GraceLeftNs)-gap, 0), l.Window)
	return handover{pid: x.PID, version: prev.Version, window: w, graceLeft: grace, gap: gap}, true
}

// carried is the handover's window while it holds (ExitGrace of awake time
// after the start, as the start grace counts awake time), else 0.
func (c *core) carried() time.Duration {
	if c.handover == nil || c.mono-c.startMono >= c.limits().ExitGrace {
		return 0
	}
	return c.handover.window
}

// carriedUntil is when the handover's window stops holding.
func (c *core) carriedUntil() time.Time {
	return c.wall.Add(c.limits().ExitGrace - (c.mono - c.startMono))
}
