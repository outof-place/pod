package daemon

import (
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// confirmBad is how long an invalid mode file must stay unchanged before it
// counts: `echo owner > mode` truncates before it writes.
const confirmBad = time.Second

// updateMode reads the switch and applies the ceilings: --mode observe, the
// test-settings guard on the real cache, and one owner per cache directory.
func (c *core) updateMode() {
	req, reason := c.modeReq, c.modeReason
	if c.cfg.ObserveOnly {
		req, reason = ownerstate.ModeObserve, "--mode observe"
	} else {
		key := c.cfg.Mode.Stat()
		awaiting := c.pendingBad == key && key != (ownerstate.ModeKey{})
		if key != c.modeKey || c.modeReadAt == 0 || c.mono-c.modeReadAt >= c.cfg.ModeEvery || awaiting {
			m, valid, why := c.cfg.Mode.Read()
			c.modeReadAt, c.modeKey = c.mono, key
			switch {
			case valid:
				req, reason, c.modeValid = m, why, true
				c.pendingBad = ownerstate.ModeKey{}
			case !c.modeValid:
				req, reason = ownerstate.ModeObserve, why
			case c.pendingBad != key:
				c.pendingBad, c.pendingAt = key, c.mono
			case c.mono-c.pendingAt >= confirmBad:
				req, reason, c.modeValid = ownerstate.ModeObserve, why, false
				c.pendingBad = ownerstate.ModeKey{}
			}
		}
	}
	eff := req
	if eff == ownerstate.ModeOwner && c.cfg.testSettings() && isRealCache(c.cfg.CacheDir) {
		eff, reason = ownerstate.ModeObserve, "test settings never own the real cache"
	}
	if eff == ownerstate.ModeOwner && c.cfg.OwnerLock != nil && !c.lockHeld {
		if c.lockTryAt == 0 || c.mono >= c.lockTryAt {
			c.lockTryAt = c.mono + time.Minute
			if release, held, err := c.cfg.OwnerLock(); err == nil && held {
				c.lockHeld, c.lockFree = true, release
			}
		}
		if !c.lockHeld {
			eff, reason = ownerstate.ModeObserve, "another daemon owns this cache directory (or it is missing)"
		}
	}
	if eff != ownerstate.ModeOwner && c.lockHeld {
		c.lockFree()
		c.lockHeld, c.lockFree, c.lockTryAt = false, nil, 0
	}
	if req != c.modeReq || reason != c.modeReason {
		c.changed = true
	}
	c.modeReq, c.modeReason = req, reason
	if eff == c.mode {
		return
	}
	c.log.Printf("mode %s -> %s (%s)", c.mode, eff, reason)
	c.mode, c.changed = eff, true
	if eff == ownerstate.ModeOwner {
		c.trimWall = time.Time{} // own trim.txt at once
	} else {
		c.clearPending() // no removal after the switch is noticed
	}
}

// releaseOwner drops the cache-directory lock (shutdown, replaced root).
func (c *core) releaseOwner() {
	if c.lockHeld {
		c.lockFree()
		c.lockHeld, c.lockFree, c.lockTryAt = false, nil, 0
	}
}
