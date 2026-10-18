package daemon

import (
	"bytes"
	"errors"
	"math"
	"slices"
	"strconv"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/index"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

type batch struct {
	files     int
	bytes     int64
	minMargin time.Duration
	done      map[index.ID]bool
}

// execute removes planned units in plan order within this tick's budget:
// each -a goes first, its output later (removePending). It returns whether
// work is left.
func (c *core) execute(full bool) (more bool) {
	if c.inGrace() || c.episode.Paused(c.mono) {
		return false
	}
	if c.plan.Bytes == 0 && len(c.pending) == 0 {
		return false
	}
	if c.live.other {
		return false // the publishing daemon's clients pin what this one cannot see
	}
	c.refreshProcs(false)
	c.prio(!full)
	defer c.prio(false)

	limit, spend := c.cfg.BatchUnits, c.cfg.BatchTime
	if full {
		limit, spend = math.MaxInt, c.cfg.FullBatchTime
	}
	now := c.cfg.Clock.Mono()
	deadline, pollUntil := now+spend, now+spend/2
	pollTime := func() bool { return c.cfg.Clock.Mono() < pollUntil && !c.stopping() }
	// Outputs go only after a full poll and relist in this batch, so every -a
	// written meanwhile is known; half the batch at most, so -a files still go.
	fresh := c.idx.Poll(pollTime) && c.idx.RelistDirty(pollTime)
	if fresh {
		c.relistAt = c.mono
	}
	b := batch{minMargin: math.MaxInt64, done: map[index.ID]bool{}}

	if fresh {
		if more = c.removePending(&b, deadline); more {
			c.finishBatch(&b)
			return true
		}
	}
	for i := range c.plan.Units {
		if b.files >= limit || c.cfg.Clock.Mono() >= deadline || c.stopping() {
			more = true
			break
		}
		if !c.stillOwner(i) || !c.clockSteady() {
			break
		}
		if c.room() == 0 || c.episode.Paused(c.mono) {
			break
		}
		c.evictUnit(&c.plan.Units[i], &b)
	}
	if d, ok := c.nextSettle(); ok && d == 0 {
		more = true // settled outputs wait for a fresh poll
	}
	c.finishBatch(&b)
	return more
}

// nextSettle is how long until the first queued output settles; ok is false
// when none is queued.
func (c *core) nextSettle() (d time.Duration, ok bool) {
	d = math.MaxInt64
	for _, p := range c.pending {
		d = min(d, max(0, p.since+c.cfg.OutputSettle-c.mono))
	}
	return d, len(c.pending) > 0
}

// stillOwner re-reads the mode switch every 32 units of a long batch.
func (c *core) stillOwner(i int) bool {
	if i%32 != 0 || i == 0 || !c.clockSteady() {
		return true
	}
	c.wall, c.mono = c.cfg.Clock.Wall(), c.cfg.Clock.Mono()
	if c.cfg.Mode.Stat() != c.modeKey || c.pendingBad != (ownerstate.ModeKey{}) {
		c.updateMode()
	}
	return c.mode == ownerstate.ModeOwner
}

func (c *core) finishBatch(b *batch) {
	if len(b.done) > 0 {
		c.sorted = slices.DeleteFunc(c.sorted, func(x evict.Candidate) bool { return b.done[x.ID] })
		c.plan = evict.Assign(c.sorted, c.needs(), c.windows(), c.room())
	}
	if b.files == 0 {
		return
	}
	c.changed = true
	c.log.Printf("evict files=%d bytes=%s minMargin=%s tier=%s window=%s",
		b.files, gb(b.bytes), b.minMargin.Round(time.Second), c.tier, c.window.Round(time.Second))
}

// cutoff converts a window into the newest recency (wall ns) a removal may
// still accept, giving back the credit of any sleep after planned recency.
// It reads the wall clock again: a go process touching a file after a clock
// step back must not look idle against the tick's older time.
func (c *core) cutoff(window time.Duration, plannedRecency int64) int64 {
	return min(c.wall.UnixNano(), c.cfg.Clock.Wall().UnixNano()) - int64(window) - c.jumps.credit(plannedRecency)
}

// clockSteady reports whether wall and awake time moved together since the
// tick began; after a sleep or a clock step the batch stops, and the next
// tick accounts for the jump before anything else is removed.
func (c *core) clockSteady() bool {
	dWall := c.cfg.Clock.Wall().Sub(c.wall)
	dMono := c.cfg.Clock.Mono() - c.mono
	d := dWall - dMono
	return d < c.cfg.JumpTolerance && d > -c.cfg.JumpTolerance
}

// stageWindow is the window a removal must respect now: a relaxed window
// only while its tier lasts (D3), and never less than planned, since the
// process window only grows while a build runs.
func (c *core) stageWindow(p evict.Stage, planned time.Duration) time.Duration {
	w := c.windows()
	cur := w.Normal
	switch {
	case p == evict.StageEmergency && c.tier == evict.Emergency:
		cur = w.Emergency
	case p >= evict.StageHard && c.tier >= evict.Hard:
		cur = w.Hard
	}
	if cur == w.Normal {
		return max(cur, planned)
	}
	return cur
}

func (c *core) evictUnit(u *evict.Planned, b *batch) {
	b.done[u.ID] = true
	if c.live.unitKept(u) {
		c.live.skipped++
		return // pinned since the plan: a live go process holds its output
	}
	window := c.stageWindow(u.Stage, u.Window)
	cut := c.cutoff(window, u.Recency)
	if u.Orphan {
		ov, ok := c.idx.Output(u.ID)
		if ok && ov.Refs == 0 && ov.Recency < cut {
			c.queueOutput(u.ID, window, u.Stage, u.GaveWay)
		}
		return
	}
	av, ok := c.idx.Action(u.ID)
	if !ok || av.St.Mtime >= cut {
		return
	}
	// The pair rule: an -a is as recent as its output (shared outputs too).
	if av.HasOut {
		if ov, ok := c.idx.Output(av.Out); ok && !c.outputIdleOnDisk(av.Out, ov, cut) {
			return
		}
	}
	out, st, err := c.fs.RemoveIfIdle(av.Rel, av.St.Ino, cut)
	switch out {
	case cachefs.Removed:
		c.idx.RemovedAction(u.ID)
		c.record(av.Rel, st.Mtime, st.Alloc, window, u.Stage, b)
		if av.HasOut && c.idx.Refs(av.Out) == 0 {
			if _, ok := c.idx.Output(av.Out); ok {
				c.queueOutput(av.Out, window, u.Stage, u.GaveWay)
			}
		}
	case cachefs.Fresh:
		c.idx.RefreshAction(u.ID, st)
	case cachefs.Gone, cachefs.Replaced:
		c.idx.Forget(u.ID, cachefs.KindAction, out == cachefs.Gone)
	case cachefs.Refused:
		c.refused(u.ID, cachefs.KindAction, av.Rel, err)
	}
}

// outputIdleOnDisk lstat's the output (and its executable) again and reports
// whether its recency is still older than cut.
func (c *core) outputIdleOnDisk(id index.ID, ov index.OutputView, cut int64) bool {
	st, err := c.fs.Lstat(ov.Rel)
	if err != nil {
		return true // gone: nothing to protect
	}
	rec := st.Recency()
	if st.Type == cachefs.Dir {
		rec = st.Mtime
		if ov.Shape == index.ShapeExec {
			if ist, err := c.fs.Lstat(ov.Rel + "/" + ov.Inner); err == nil {
				rec = max(rec, ist.Recency())
				c.idx.RefreshOutput(id, ist, true)
			}
		}
	}
	c.idx.RefreshOutput(id, st, false)
	return rec < cut
}

// queueOutput schedules an output for removal after OutputSettle and arms
// its atime, so any read meanwhile shows up as use and keeps it.
func (c *core) queueOutput(id index.ID, window time.Duration, stage evict.Stage, gaveWay bool) {
	if p, ok := c.pending[id]; ok {
		p.window, p.stage, p.gaveWay = max(window, p.window), stage, p.gaveWay && gaveWay
		c.pending[id] = p
		return
	}
	ov, ok := c.idx.Output(id)
	if !ok {
		return
	}
	if ov.Shape != index.ShapeEmptyDir {
		rel, inner := ov.Rel, false
		if ov.Shape == index.ShapeExec {
			rel, inner = ov.Rel+"/"+ov.Inner, true
		}
		st, err := c.fs.Lstat(rel)
		if err != nil || st.Type != cachefs.Regular {
			c.idx.MarkDirty(id)
			return
		}
		c.idx.RefreshOutput(id, st, inner)
		if st.Recency() >= c.cutoff(c.stageWindow(stage, window), st.Recency()) {
			return
		}
		// Only an unread file (atime == mtime, as go writes it) is armed: a
		// later atime is read evidence that a wider window may still need.
		if st.Atime == st.Mtime {
			c.fs.Arm(rel, st.Mtime-int64(time.Second))
		}
	}
	c.pending[id] = pendingOut{since: c.mono, window: window, stage: stage, bytes: ov.Bytes, gaveWay: gaveWay}
	c.pendingBytes += ov.Bytes
}

func (c *core) unqueue(id index.ID) pendingOut {
	p := c.pending[id]
	delete(c.pending, id)
	c.pendingBytes -= p.bytes
	return p
}

func (c *core) clearPending() {
	clear(c.pending)
	c.pendingBytes = 0
}

// removePending removes queued outputs that settled. It returns true when
// the deadline or a stop cut it short. Each chunk runs the dying handshake with the
// clients: published as dying first, then the pins drained, so an output a
// client handed to go is either seen pinned here or answered as a miss.
func (c *core) removePending(b *batch, deadline time.Duration) bool {
	if len(c.pending) == 0 {
		return false
	}
	ids := make([]index.ID, 0, len(c.pending))
	for id, p := range c.pending {
		if c.mono-p.since >= c.cfg.OutputSettle {
			ids = append(ids, id)
		}
	}
	slices.SortFunc(ids, func(a, b index.ID) int { return bytes.Compare(a[:], b[:]) })
	for len(ids) > 0 {
		chunk := ids[:min(len(ids), livestate.MaxDying)]
		ids = ids[len(chunk):]
		if !c.beginDying(chunk) {
			return false
		}
		cut, stop := c.removeChunk(chunk, b, deadline)
		c.endDying()
		if cut || stop {
			return cut
		}
	}
	return false
}

func (c *core) removeChunk(chunk []index.ID, b *batch, deadline time.Duration) (cut, stop bool) {
	for _, id := range chunk {
		if c.cfg.Clock.Mono() >= deadline || c.stopping() {
			return true, false
		}
		if !c.clockSteady() {
			return false, true
		}
		p := c.unqueue(id)
		ov, ok := c.idx.Output(id)
		if !ok || ov.Refs > 0 {
			continue // gone, or an -a references it again
		}
		// A quick drain right before the unlink: a put that found the output
		// dying and is writing it again has pinned it by now.
		if c.live.open && !c.live.drain(c, c.cfg.Clock.Mono(), false) {
			return false, true
		}
		if !p.gaveWay && c.live.keeps(id) {
			c.live.skipped++
			continue
		}
		if c.cfg.BeforeRemoveOutput != nil {
			c.cfg.BeforeRemoveOutput(id)
		}
		if !c.live.batchFresh(c.cfg.Clock.Mono()) {
			return true, false // stopped or starved mid-batch: the output is planned again
		}
		window := c.stageWindow(p.stage, p.window)
		c.removeOutput(id, ov, window, p.stage, b)
	}
	return false, false
}

func (c *core) removeOutput(id index.ID, ov index.OutputView, window time.Duration, stage evict.Stage, b *batch) {
	cut := c.cutoff(window, ov.Recency)
	switch ov.Shape {
	case index.ShapeFile:
		out, st, err := c.fs.RemoveIfIdle(ov.Rel, ov.St.Ino, cut)
		c.outputOutcome(id, ov.Rel, out, st, err, window, stage, b, false)
	case index.ShapeExec:
		// D6: the directory's mtime is part of the recency; then the
		// executable, then the empty directory.
		if dst, err := c.fs.Lstat(ov.Rel); err != nil || dst.Mtime >= cut {
			if err == nil {
				c.idx.RefreshOutput(id, dst, false)
			}
			return
		}
		rel := ov.Rel + "/" + ov.Inner
		out, st, err := c.fs.RemoveIfIdle(rel, ov.InnerSt.Ino, cut)
		if out != cachefs.Removed {
			c.outputOutcome(id, rel, out, st, err, window, stage, b, true)
			return
		}
		if c.cfg.AfterInnerUnlink != nil {
			c.cfg.AfterInnerUnlink()
		}
		// Our own unlink just touched the directory; rmdir still refuses a
		// directory a racing go run refilled.
		dout, _ := c.fs.RemoveEmptyDir(ov.Rel, math.MaxInt64)
		freed := st.Alloc
		if dout == cachefs.Removed || dout == cachefs.Gone {
			c.idx.RemovedOutput(id)
			freed += ov.St.Alloc
		} else if dst, err := c.fs.Lstat(ov.Rel); err == nil {
			c.idx.OutputEmptied(id, dst)
			c.idx.MarkDirty(id)
		}
		c.record(rel, st.Recency(), freed, window, stage, b)
	case index.ShapeEmptyDir:
		out, err := c.fs.RemoveEmptyDir(ov.Rel, cut)
		c.outputOutcome(id, ov.Rel, out, cachefs.Stat{Mtime: ov.St.Mtime, Alloc: ov.St.Alloc}, err, window, stage, b, false)
	}
}

func (c *core) outputOutcome(id index.ID, rel string, out cachefs.Outcome, st cachefs.Stat, err error, window time.Duration, stage evict.Stage, b *batch, inner bool) {
	switch out {
	case cachefs.Removed:
		c.idx.RemovedOutput(id)
		c.record(rel, st.Recency(), st.Alloc, window, stage, b)
	case cachefs.Fresh:
		c.idx.RefreshOutput(id, st, inner)
	case cachefs.Gone, cachefs.Replaced:
		c.idx.Forget(id, cachefs.KindOutput, out == cachefs.Gone)
	case cachefs.Refused:
		c.refused(id, cachefs.KindOutput, rel, err)
	}
}

func (c *core) refused(id index.ID, kind byte, rel string, err error) {
	c.idx.MarkStuck(id, kind, c.wall.Add(c.cfg.StuckRetry).UnixNano())
	if !c.refusedLogged[rel] {
		c.refusedLogged[rel] = true
		msg := "not a regular file"
		if err != nil {
			msg = err.Error()
		}
		c.log.Printf("refused %s: %s (retry in %s)", rel, msg, c.cfg.StuckRetry)
	}
	c.changed = true
}

func (c *core) record(rel string, recency, bytes int64, window time.Duration, stage evict.Stage, b *batch) {
	age := c.jumps.age(c.wall.UnixNano(), recency)
	c.evictions.Count++
	c.evictions.Bytes += bytes
	c.evictions.LastAt = c.wall.Unix()
	// Only bytes below the budget count against the episode cap (D4): getting
	// down to the budget doesn't depend on free disk. The index is already
	// updated here.
	overBefore := max(0, c.idx.Size()+bytes-c.limits().Budget)
	c.episode.Evict(max(0, bytes-overBefore), c.free, c.idx.Added, c.mono)
	b.files++
	b.bytes += bytes
	b.minMargin = min(b.minMargin, age-window)
	if c.cfg.OnEvict != nil {
		c.cfg.OnEvict(Eviction{Rel: rel, Wall: c.wall.UnixNano(), Recency: recency, Age: age, Window: window, Bytes: bytes, Stage: stage, Tier: c.tier})
	}
}

// normalizeFuture gives entries dated far in the future (a bad clock, a
// touch) today's time once, so Go's hourly refresh and the window work again.
func (c *core) normalizeFuture() {
	limit := c.wall.Add(c.cfg.FutureTolerance).UnixNano()
	now := c.wall.UnixNano()
	n := 0
	for _, cand := range c.sorted {
		if cand.FutureAt == 0 || n >= 64 {
			continue
		}
		rels := []string{cachefs.EntryRel(cand.ID, cachefs.KindAction)}
		if cand.Orphan {
			rels = rels[:0]
		}
		if cand.HasOut {
			rels = append(rels, cachefs.EntryRel(cand.Out, cachefs.KindOutput))
		}
		for _, rel := range rels {
			st, err := c.fs.Lstat(rel)
			if err != nil || max(st.Mtime, st.Atime) <= limit {
				continue
			}
			if err := c.fs.SetTimes(rel, now); err == nil {
				n++
				if !c.futureLogged[rel] {
					c.futureLogged[rel] = true
					c.log.Printf("future-timestamp %s at %s set to now", rel, time.Unix(0, max(st.Mtime, st.Atime)).UTC().Format(time.RFC3339))
				}
			}
		}
		c.idx.MarkDirty(cand.ID)
	}
	if n > 0 {
		c.idx.RestatStep(256, c.scanMore)
		c.planAt = -1 << 62
	}
}

// maybeTrim owns trim.txt in owner mode: the current time, rewritten every
// TrimEvery and after a clock jump, so Go's daily trim never starts.
func (c *core) maybeTrim() {
	if c.mode != ownerstate.ModeOwner || !c.idx.RootOK() {
		return
	}
	due := c.trimWall.IsZero() || c.mono-c.trimAt >= c.cfg.TrimEvery || c.jumped
	if !due || (c.trimErr != "" && c.mono < c.trimRetryAt && !c.jumped) {
		return
	}
	if err := c.fs.WriteTrim([]byte(strconv.FormatInt(c.wall.Unix(), 10))); err != nil {
		// Go holds trim.txt's lock for one read: retry next tick, and call it
		// a failure only when it stays locked for a minute.
		if errors.Is(err, cachefs.ErrTrimBusy) {
			if !c.trimBusy {
				c.trimBusy, c.trimBusyAt = true, c.mono
			}
			if c.mono-c.trimBusyAt < time.Minute {
				return
			}
		}
		if c.trimErr == "" {
			c.log.Printf("trim.txt not written: %v (Go's own trim is not suppressed; retry in 10m)", err)
		}
		c.trimErr, c.trimRetryAt, c.changed = err.Error(), c.mono+10*time.Minute, true
		c.trimBusy = false
		return
	}
	if c.trimErr != "" {
		c.log.Printf("trim.txt written again")
		c.changed = true
	}
	c.trimErr, c.trimAt, c.trimWall, c.trimBusy = "", c.mono, c.wall, false
}

// Client temp files (amendment 4): a put streams into <xx>/.pgc-tmp.<pid>.<seq>
// and renames it into place, so a leftover is garbage once its writer is gone
// for 10 minutes, or 2 hours old whatever its pid says (pids get reused).
const (
	tempDeadAge = 10 * time.Minute
	tempMaxAge  = 2 * time.Hour
)

func (c *core) sweepTemps() {
	if c.idx.TempBytes() == 0 {
		return
	}
	c.refreshProcs(false)
	c.temps = c.idx.Temps(c.temps[:0])
	n := 0
	for _, t := range c.temps {
		if n >= 64 {
			break
		}
		age := tempMaxAge
		if c.procsOK && !c.livePids[int32(t.PID)] {
			age = tempDeadAge
		}
		cut := c.cutoff(age, t.St.Mtime)
		if t.St.Mtime >= cut {
			continue
		}
		n++
		out, st, err := c.fs.RemoveTemp(t.Rel, t.St.Ino, cut)
		switch out {
		case cachefs.Removed:
			c.idx.RemovedTemp(t.Rel)
			c.tempSwept.Count++
			c.tempSwept.Bytes += st.Alloc
			c.tempSwept.LastAt = c.wall.Unix()
			c.changed = true
			c.log.Printf("swept client temp %s pid=%d bytes=%s", t.Rel, t.PID, gb(st.Alloc))
		case cachefs.Gone, cachefs.Replaced:
			c.idx.RemovedTemp(t.Rel)
		case cachefs.Refused:
			c.log.Once("temp:"+t.Rel, "temp %s not removed: %v", t.Rel, err)
		}
	}
}
