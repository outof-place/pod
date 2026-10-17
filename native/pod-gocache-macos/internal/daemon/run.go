package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// lockTries x lockPause stays under a second: a duplicate exits fast, and a
// brief lock probe by another tool doesn't make the real daemon quit.
const (
	lockTries = 4
	lockPause = 200 * time.Millisecond
)

// Run is the daemon: one instance per state directory. It returns the exit
// code: 0 on SIGTERM, for a duplicate instance, and when the crash-loop
// breaker trips (launchd must not respawn any of those).
func Run(ctx context.Context, cfg Config) int {
	stderr := cfg.Log
	if stderr == nil {
		stderr = os.Stderr
		cfg.Log = os.Stderr
	}
	// The state directory comes first: the lock and the crash-loop record
	// live there, so a bad --cache-dir is caught by the breaker too.
	var err error
	if cfg.StateDir == "" {
		cfg.StateDir, err = DefaultStateDir()
	} else {
		cfg.StateDir, err = absClean("--state-dir", cfg.StateDir)
	}
	if err != nil {
		fmt.Fprintf(stderr, "pod-gocache daemon: %v\n", err)
		return exitFor(err)
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		fmt.Fprintf(stderr, "pod-gocache daemon: state dir: %v\n", err)
		return ExitIO
	}
	unlock, holder, err := lockState(cfg.StateDir)
	if err != nil {
		fmt.Fprintf(stderr, "pod-gocache daemon: lock: %v\n", err)
		return ExitIO
	}
	if unlock == nil {
		fmt.Fprintf(stderr, "pod-gocache daemon: another daemon (pid %s) holds %s; exiting\n", holder, filepath.Join(cfg.StateDir, ownerstate.LockFile))
		return ExitOK
	}
	defer unlock()
	ownerstate.CleanTemps(cfg.StateDir)

	resolved, cfgErr := cfg.withDefaults()
	if cfgErr != nil {
		// Keep enough to report the error and run the breaker.
		cfg.CacheDir = ""
		resolved, _ = cfg.withDefaultsNoCache()
	}
	cfg = resolved
	log := NewLogger(cfg.Log, func() time.Time { return cfg.Clock.Wall() })
	if cfg.Log == os.Stderr {
		log.rotateStderr(cfg.StateDir, cfg.LogMax)
	}
	starts, err := ownerstate.RecordStart(cfg.StateDir, cfg.Clock.Wall(), os.Getpid(), cfg.CrashWindow)
	if err == nil && starts >= cfg.CrashLimit {
		return tripBreaker(cfg, log, starts)
	}
	if cfgErr != nil {
		log.Printf("config error: %v", cfgErr)
		failState(cfg, cfgErr.Error())
		return exitFor(cfgErr)
	}

	if cfg.OwnerLock == nil {
		if _, real := cfg.FS.(*cachefs.OS); real {
			dir := cfg.CacheDir
			cfg.OwnerLock = func() (func(), bool, error) { return cachefs.LockDir(dir) }
		}
	}
	runtime.LockOSThread() // the loop's thread is the one whose priority drops
	defer runtime.UnlockOSThread()
	if _, isNo := cfg.Prio.(noPriority); isNo {
		cfg.Prio = ThreadPriority{}
	}
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	c := newCore(cfg, log)
	c.restarts = max(0, starts-1)
	c.log.Printf("start version=%s pid=%d cache=%s state=%s restarts=%d", cfg.Version, c.pid, cfg.CacheDir, cfg.StateDir, starts-1)
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			c.shutdown()
			ownerstate.ClearStart(cfg.StateDir, c.pid)
			return ExitOK
		case <-timer.C:
		}
		next := c.tick()
		timer.Reset(next)
	}
}

func exitFor(err error) int {
	if errors.Is(err, ErrRelative) {
		return ExitUsage
	}
	return ExitConfig
}

// failState records a startup error in state.json, so status shows it, and
// tells owner.json readers there is no owner.
func failState(cfg Config, msg string) {
	now := cfg.Clock.Wall()
	disown(cfg, now)
	cfg.Sink.WriteState(ownerstate.State{
		Version: cfg.Version, Mode: ownerstate.ModeObserve, CacheDir: cfg.CacheDir, BudgetBytes: cfg.Limits.Budget,
		Extra: ownerstate.Extra{PID: os.Getpid(), StartedAt: now.Unix(), Phase: PhaseError, Error: msg, Reasons: []string{"daemon stopped: " + msg}},
	})
}

// disown writes owner.json in observe mode: readers resume at once.
func disown(cfg Config, now time.Time) {
	cfg.Sink.WriteOwner(ownerstate.Owner{
		Schema: ownerstate.Schema, Version: cfg.Version, PID: os.Getpid(), StartedAt: now.Unix(), HeartbeatAt: now.Unix(),
		Mode: ownerstate.ModeObserve, CacheDir: cfg.CacheDir, BudgetBytes: cfg.Limits.Budget,
	})
}

// shutdown says observe in owner.json, so the old trimmers resume at once
// rather than up to 120 s later, and writes a last state.json.
func (c *core) shutdown() {
	c.wall, c.mono = c.cfg.Clock.Wall(), c.cfg.Clock.Mono()
	c.releaseOwner()
	st := c.stateFile()
	c.mode = ownerstate.ModeObserve
	c.writeOwner(c.ownerFile(c.wall), c.mono)
	st.Mode, st.Extra.Phase = ownerstate.ModeObserve, PhaseStopped
	st.Extra.Reasons = append([]string{"daemon stopped at " + c.wall.Format("15:04") + "; nothing owns the cache, the old trimmers resume; the rest is as it was then"}, st.Extra.Reasons...)
	if err := c.cfg.Sink.WriteState(st); err != nil {
		c.log.Printf("state.json not written: %v", err)
	}
	c.log.Printf("stop evicted=%d bytes=%s", c.evictions.Count, gb(c.evictions.Bytes))
}

// tripBreaker stops a crash loop: one line, owner.json in observe mode,
// state.json with the error, and a clean exit so launchd stops respawning;
// Pod's next launch starts it again.
func tripBreaker(cfg Config, log *Logger, starts int) int {
	msg := fmt.Sprintf("crash loop: %d starts within %s without a clean exit; staying down until Pod restarts the daemon", starts, cfg.CrashWindow)
	log.Printf("%s", msg)
	now := cfg.Clock.Wall()
	disown(cfg, now)
	cfg.Sink.WriteState(ownerstate.State{
		Version: cfg.Version, Mode: ownerstate.ModeObserve, CacheDir: cfg.CacheDir, BudgetBytes: cfg.Limits.Budget,
		Extra: ownerstate.Extra{PID: os.Getpid(), StartedAt: now.Unix(), Phase: PhaseCrashLoop, Error: msg, Restarts: starts, Reasons: []string{msg}},
	})
	ownerstate.ResetStarts(cfg.StateDir)
	return ExitOK
}

// lockState takes daemon.lock with flock and writes our pid into it. A nil
// unlock with no error means another live daemon holds it (holder is its pid).
func lockState(dir string) (unlock func(), holder string, err error) {
	path := filepath.Join(dir, ownerstate.LockFile)
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, "", err
	}
	fd := int(f.Fd())
	for i := 0; ; i++ {
		err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EINTR {
			f.Close()
			return nil, "", err
		}
		if i == lockTries {
			var buf [32]byte
			n, _ := f.ReadAt(buf[:], 0)
			f.Close()
			return nil, strings.TrimSpace(string(buf[:n])), nil
		}
		time.Sleep(lockPause)
	}
	f.Truncate(0)
	f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	return func() { f.Close() }, "", nil
}
