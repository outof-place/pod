package livestate

import (
	"errors"
	"syscall"
	"time"
)

// Reason says why a session goes without (part of) the shared state.
type Reason uint8

const (
	ReasonOK      Reason = iota
	ReasonNoRoot         // no HOME, or a relative POD_GOCACHE_LIVE_DIR
	ReasonNoCache        // GOCACHE is not a directory
	ReasonMissing        // no live directory or file: no daemon publishes for this cache
	ReasonInvalid        // wrong version, magic, size, cache, owner or file type
	ReasonDenied         // EACCES or EPERM (a sandbox)
	ReasonNoSlot         // every client slot is held
	ReasonFault          // a mapped file faulted during the session
	ReasonError          // anything else
	ReasonOff            // POD_GOCACHE_LIVE=off
)

var reasonNames = [...]string{"ok", "no-root", "no-cache", "missing", "invalid", "denied", "no-slot", "fault", "error", "off"}

func (r Reason) String() string {
	if int(r) < len(reasonNames) {
		return reasonNames[r]
	}
	return "unknown"
}

func reasonFor(err error) Reason {
	switch {
	case err == nil:
		return ReasonOK
	case errors.Is(err, syscall.ENOENT):
		return ReasonMissing
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return ReasonDenied
	case errors.Is(err, ErrNoSlot):
		return ReasonNoSlot
	case errors.Is(err, errBadIndex), errors.Is(err, errBadClients), errors.Is(err, errNotRegular),
		errors.Is(err, errForeign), errors.Is(err, errSize), errors.Is(err, syscall.ELOOP):
		return ReasonInvalid
	}
	return ReasonError
}

// Client is one go command's view of the shared state. Every method is safe
// to call when parts are missing, and none of them can fail a get: a fault in
// a mapping turns that part off for the rest of the session.
type Client struct {
	dir   string
	id    CacheID
	idx   *Index
	slot  *Slot
	Index Reason // why the index is not in use, or ReasonOK
	Pins  Reason // why no slot is held, or ReasonOK
	// wait is what is left of the session's budget for waiting on a dying
	// batch (a put replacing an output the daemon is deleting).
	wait time.Duration
	// Session counts, for the trace.
	Fast, Disk, Stale, DyingMisses, DyingPuts uint64
}

// WaitBudget bounds a session's total wait on the daemon.
const WaitBudget = 50 * time.Millisecond

// OpenClient opens the live state for the cache directory gocache (as go
// passed it). It takes about 30 us: one stat, two opens, three mmaps and a
// byte-range lock.
func OpenClient(gocache string, goPID int) *Client {
	c := &Client{wait: WaitBudget}
	root, ok := Root()
	if !ok {
		c.Index, c.Pins = ReasonNoRoot, ReasonNoRoot
		return c
	}
	if c.id, ok = StatCache(gocache); !ok {
		c.Index, c.Pins = ReasonNoCache, ReasonNoCache
		return c
	}
	c.dir = Dir(root, c.id)
	var err error
	if c.idx, err = OpenIndex(c.dir, c.id); err != nil {
		c.Index = reasonFor(err)
	}
	if c.slot, err = ClaimSlot(c.dir, c.id, BootID(), goPID); err != nil {
		c.Pins = reasonFor(err)
	}
	return c
}

// Disabled is a client for a session that must not touch the shared state.
func Disabled(r Reason) *Client { return &Client{Index: r, Pins: r} }

// Lookup returns the published entry for id. The caller still compares the
// -a file's inode and ctime with the entry before serving it.
func (c *Client) Lookup(id *[32]byte, e *Entry) bool {
	if c.idx == nil {
		return false
	}
	found := false
	if !protect(func() {
		if c.idx.Superseded() {
			c.reopen()
			if c.idx == nil {
				return
			}
		}
		found = c.idx.Lookup(id, e) == Found
	}) {
		c.dropIndex(ReasonFault)
		return false
	}
	return found
}

// reopen moves to the index that superseded the mapped one.
func (c *Client) reopen() {
	next, err := OpenIndex(c.dir, c.id)
	c.idx.Close()
	c.idx = next
	if err != nil {
		c.Index = reasonFor(err)
	}
}

func (c *Client) dropIndex(r Reason) {
	if c.idx != nil {
		c.idx.Close()
		c.idx = nil
	}
	c.Index = r
}

// Pin logs out as handed to go and reports whether the daemon is deleting
// it. Without a slot nothing is logged and nothing is dying.
func (c *Client) Pin(out, action *[32]byte, kind uint64, size int64) (dying bool) {
	if c.slot == nil {
		return false
	}
	if !protect(func() { dying = c.slot.Pin(out, action, kind, size) }) {
		c.slot, c.Pins, dying = nil, ReasonFault, false
	}
	return dying
}

// Dying reports whether out is in the daemon's active dying batch.
func (c *Client) Dying(out *[32]byte) (dying bool) {
	if c.slot == nil {
		return false
	}
	if !protect(func() { dying = c.slot.Dying(Prefix(out)) }) {
		c.slot, c.Pins, dying = nil, ReasonFault, false
	}
	return dying
}

// Nap sleeps d out of the session's wait budget and reports false, without
// sleeping, once the budget is spent: a stopped daemon costs a session at
// most WaitBudget in total.
func (c *Client) Nap(d time.Duration) bool {
	if c.wait < d {
		c.wait = 0
		return false
	}
	c.wait -= d
	time.Sleep(d)
	return true
}

// Count bumps a slot counter (CountFastHit, ...).
func (c *Client) Count(field int) {
	if c.slot != nil && !protect(func() { c.slot.Count(field) }) {
		c.slot, c.Pins = nil, ReasonFault
	}
}

// HasSlot reports whether pins are being logged.
func (c *Client) HasSlot() bool { return c.slot != nil }

// Overflowed reports whether the slot's log filled up.
func (c *Client) Overflowed() bool { return c.slot != nil && c.slot.Overflowed() }

// Close marks the slot closed. The slot's lock is released when the process
// exits, which is when the daemon stops counting its pins.
func (c *Client) Close() {
	if c.slot != nil {
		c.slot.Close()
	}
	if c.idx != nil {
		c.idx.Close()
		c.idx = nil
	}
}
