package daemon

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// beat is owner.json's single writer path. The loop hands it every owner.json
// it publishes; a goroutine of its own rewrites the last one with a fresh
// heartbeatAt once it falls due. That goroutine is never locked to the loop's
// thread, so it stays out of the background band: at load 100 to 168 (18.10)
// a background thread waited minutes for the CPU and the old trimmers took
// the cache back from a live owner. It writes only while the loop progressed
// within limit, so a wedged loop still goes stale.
type beat struct {
	sink  Sink
	clock Clock
	log   *Logger
	every time.Duration
	limit time.Duration

	progress atomic.Int64 // mono ns of the loop's last tick or file system call
	wroteAt  atomic.Int64 // mono ns of the last owner.json write, by either writer

	mu       sync.Mutex // held across every owner.json write, so writes land in publish order
	last     ownerstate.Owner
	have     bool
	stopped  bool
	stall    time.Duration // longest loop stall this episode the goroutine covered (0: none)
	silenced bool          // past limit: the goroutine has stopped writing

	quit chan struct{}
	done chan struct{}
	once sync.Once
}

func newBeat(sink Sink, clock Clock, log *Logger, every, limit time.Duration) *beat {
	b := &beat{sink: sink, clock: clock, log: log, every: every, limit: limit}
	b.wroteAt.Store(-1 << 62)
	b.progress.Store(int64(clock.Mono()))
	return b
}

// mark records the loop's progress; it is on every file system call's path.
func (b *beat) mark(mono time.Duration) { b.progress.Store(int64(mono)) }

// age is how long ago owner.json was last written, by either writer.
func (b *beat) age(mono time.Duration) time.Duration {
	return mono - time.Duration(b.wroteAt.Load())
}

// publish makes o the content the goroutine refreshes and, with write, writes
// it now. Holding the mutex across the write means a goroutine refresh never
// lands after a newer publish, so after the loop publishes observe no owner
// heartbeat follows.
func (b *beat) publish(o ownerstate.Owner, mono time.Duration, write bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.last, b.have = o, true
	if write {
		b.write(o, mono)
	}
}

func (b *beat) write(o ownerstate.Owner, mono time.Duration) {
	b.wroteAt.Store(int64(mono))
	if err := b.sink.WriteOwner(o); err != nil {
		b.log.Once("owner-write", "owner.json not written: %v", err)
	}
}

// start runs the heartbeat goroutine until stop.
func (b *beat) start() {
	b.quit, b.done = make(chan struct{}), make(chan struct{})
	go func() {
		defer close(b.done)
		t := time.NewTimer(b.every)
		defer t.Stop()
		for {
			select {
			case <-b.quit:
				return
			case <-t.C:
			}
			t.Reset(b.refresh())
		}
	}()
}

// stop ends the goroutine and waits for it: every owner.json write after it
// is the loop's, so shutdown's observe is the last word.
func (b *beat) stop() {
	b.mu.Lock()
	b.stopped = true
	b.mu.Unlock()
	b.once.Do(func() {
		if b.quit != nil {
			close(b.quit)
			<-b.done
		}
	})
}

// refresh rewrites the last published owner.json with a fresh heartbeatAt
// when it is due and the loop progressed within limit. It returns how long
// to wait before the next look.
func (b *beat) refresh() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.clock.Mono()
	if b.stopped || !b.have {
		return b.every
	}
	idle := now - time.Duration(b.progress.Load())
	if idle > b.limit {
		if !b.silenced {
			b.silenced = true
			b.log.Printf("loop made no progress for %s: heartbeat stopped, owner.json goes stale within 2 minutes", idle.Round(time.Second))
		}
		return b.every
	}
	switch {
	case b.silenced:
		b.silenced, b.stall = false, 0
		b.log.Printf("loop progressing again: heartbeat resumed")
	case idle >= b.every:
		if b.stall == 0 {
			b.log.Printf("loop stalled for %s: the heartbeat goroutine keeps owner.json fresh", idle.Round(time.Second))
		}
		b.stall = max(b.stall, idle)
	case b.stall > 0:
		b.log.Printf("loop progressing again after a stall of at least %s", b.stall.Round(time.Second))
		b.stall = 0
	}
	if wait := b.every - b.age(now); wait > 0 {
		return wait
	}
	o := b.last
	o.HeartbeatAt = b.clock.Wall().Unix()
	b.write(o, now)
	return b.every
}
