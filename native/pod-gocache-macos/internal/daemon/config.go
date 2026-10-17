// Package daemon is pod-gocache's owner of the Go build cache: it indexes the
// GOCACHE directory, keeps it within budget and gives disk back when the
// disk runs low, never deleting what a build could still use, and publishes
// owner.json so the old trimmers stand down. It starts in observe mode.
package daemon

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/cachefs"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/diskstat"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/evict"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/procscan"
)

// Config is everything Run needs. Zero fields take production defaults; the
// seams (FS, Disk, ...) default to the real machine.
type Config struct {
	CacheDir    string // absolute; default os.UserCacheDir()/go-build
	StateDir    string // absolute; default ~/.pod/gocache
	Version     string
	ObserveOnly bool // --mode observe: a ceiling over the mode file

	Limits evict.Limits
	Policy evict.Policy

	Tick            time.Duration // loop period; also how often free disk is sampled
	HeartbeatEvery  time.Duration
	TrimEvery       time.Duration
	ModeEvery       time.Duration // forced re-read of the mode file
	IdleRelist      time.Duration // bucket poll cadence with plenty of disk
	PressureRelist  time.Duration // bucket poll cadence below DiskFloor
	PlanEvery       time.Duration // full re-sort of the candidates
	ProcEvery       time.Duration // process table refresh
	ScanBudget      time.Duration // time per tick for indexing, polling and re-stats
	RestatCycle     time.Duration // full re-stat of every entry with plenty of disk
	PressureRestat  time.Duration // full re-stat cycle below DiskFloor
	BatchUnits      int           // removals per tick when throttled
	BatchTime       time.Duration // time per tick spent removing when throttled
	FullBatchTime   time.Duration // the same at full speed
	OutputSettle    time.Duration // an output is removed this long after its last -a
	StuckRetry      time.Duration // a refused removal is retried after this
	FutureTolerance time.Duration // timestamps further ahead are normalized
	JumpTolerance   time.Duration // wall vs monotonic drift that counts as a jump
	CrashWindow     time.Duration
	CrashLimit      int
	LogMax          int64

	FS        cachefs.FS
	Disk      diskstat.Source
	Procs     procscan.Lister
	Clock     Clock
	Sink      Sink
	Mode      ModeSource
	Prio      Priority
	OwnerLock func() (release func(), held bool, err error)
	Log       io.Writer

	// Test hooks.
	OnEvict          func(Eviction)
	AfterInnerUnlink func()
}

// Eviction describes one removal, for tests and the log.
type Eviction struct {
	Rel     string
	Wall    int64 // unix ns
	Recency int64 // recency of the stat that decided
	Age     time.Duration
	Window  time.Duration
	Bytes   int64
	Stage   evict.Stage
	Tier    evict.Tier
}

// Sink receives the daemon's status files.
type Sink interface {
	WriteOwner(ownerstate.Owner) error
	WriteState(ownerstate.State) error
	// Previous is the last state.json, read once at start.
	Previous() (ownerstate.State, bool)
}

// ModeSource is the mode switch.
type ModeSource interface {
	Stat() ownerstate.ModeKey
	Read() (mode string, valid bool, reason string)
}

// Priority lowers the I/O and CPU priority of the loop's thread.
type Priority interface {
	Background(on bool)
}

// Exit codes of Run.
const (
	ExitOK     = 0
	ExitUsage  = 64 // EX_USAGE
	ExitConfig = 78 // EX_CONFIG
	ExitIO     = 74 // EX_IOERR
)

// ErrNoHome is returned when no default directory can be derived.
var ErrNoHome = errors.New("HOME is not set: pass --cache-dir and --state-dir")

// ErrRelative is returned for a relative --cache-dir or --state-dir.
var ErrRelative = errors.New("must be an absolute path")

// RealCacheDir is the default cache directory, os.UserCacheDir()/go-build.
func RealCacheDir() (string, error) {
	if os.Getenv("HOME") == "" {
		return "", ErrNoHome
	}
	d, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "go-build"), nil
}

// DefaultStateDir is ~/.pod/gocache.
func DefaultStateDir() (string, error) {
	h := os.Getenv("HOME")
	if h == "" {
		return "", ErrNoHome
	}
	return filepath.Join(h, ".pod", "gocache"), nil
}

func absClean(flag, p string) (string, error) {
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("%s %w, got %q", flag, ErrRelative, p)
	}
	return filepath.Clean(p), nil
}

// withDefaults resolves the directories and fills unset knobs.
func (c Config) withDefaults() (Config, error) {
	var err error
	if c.StateDir == "" {
		if c.StateDir, err = DefaultStateDir(); err != nil {
			return c, err
		}
	} else if c.StateDir, err = absClean("--state-dir", c.StateDir); err != nil {
		return c, err
	}
	if c.CacheDir == "" {
		if c.CacheDir, err = RealCacheDir(); err != nil {
			return c, err
		}
	} else if c.CacheDir, err = absClean("--cache-dir", c.CacheDir); err != nil {
		return c, err
	}
	// Resolved once: the root must be a real directory, and readers compare
	// cacheDir after resolving their own (D5).
	if r, err := filepath.EvalSymlinks(c.CacheDir); err == nil {
		c.CacheDir = r
	}
	return c.withDefaultsNoCache()
}

// withDefaultsNoCache fills every knob and seam; seams that need the cache
// directory are left nil when it is unknown.
func (c Config) withDefaultsNoCache() (Config, error) {
	if c.Limits == (evict.Limits{}) {
		c.Limits = evict.Defaults()
	}
	if c.Policy == nil {
		c.Policy = evict.AgeBuckets{}
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d == 0 {
			*d = v
		}
	}
	defInt := func(d *int, v int) {
		if *d == 0 {
			*d = v
		}
	}
	def(&c.Tick, 2*time.Second)
	def(&c.HeartbeatEvery, 30*time.Second)
	def(&c.TrimEvery, 6*time.Hour)
	def(&c.ModeEvery, time.Minute)
	def(&c.IdleRelist, 30*time.Second)
	def(&c.PressureRelist, 5*time.Second)
	def(&c.PlanEvery, 30*time.Second)
	def(&c.ProcEvery, 10*time.Second)
	def(&c.BatchTime, 3*time.Second)
	def(&c.FullBatchTime, 10*time.Second)
	def(&c.OutputSettle, 5*time.Second)
	def(&c.StuckRetry, time.Hour)
	def(&c.FutureTolerance, 6*time.Hour)
	def(&c.JumpTolerance, 30*time.Second)
	def(&c.CrashWindow, 10*time.Minute)
	def(&c.ScanBudget, 2*time.Second)
	// Go refreshes an mtime at most hourly and removal re-checks on disk, so
	// a 15 minute cycle loses nothing; each pass costs about 100k lstats.
	def(&c.RestatCycle, 15*time.Minute)
	def(&c.PressureRestat, 30*time.Second)
	defInt(&c.BatchUnits, 256)
	defInt(&c.CrashLimit, 5)
	if c.LogMax == 0 {
		c.LogMax = 1 << 20
	}
	if c.FS == nil && c.CacheDir != "" {
		c.FS = cachefs.NewOS(c.CacheDir)
	}
	if c.Disk == nil && c.CacheDir != "" {
		c.Disk = diskstat.Statfs{Path: c.CacheDir}
	}
	if c.Procs == nil {
		c.Procs = procscan.Sysctl{}
	}
	if c.Clock == nil {
		c.Clock = NewRealClock()
	}
	if c.Sink == nil {
		c.Sink = FileSink{Dir: c.StateDir}
	}
	if c.Mode == nil {
		c.Mode = FileMode{Dir: c.StateDir}
	}
	if c.Prio == nil {
		c.Prio = noPriority{}
	}
	if c.Log == nil {
		c.Log = io.Discard
	}
	return c, nil
}

// testSettings reports settings only a test would use; they never get owner
// mode on the real cache.
func (c Config) testSettings() bool {
	return c.Limits.Window < 30*time.Minute || c.Limits.Budget < evict.GB
}

// isRealCache reports whether dir is os.UserCacheDir()/go-build, or the
// same under the passwd entry's home ($HOME can point elsewhere, as in tests).
func isRealCache(dir string) bool {
	var real []string
	if d, err := RealCacheDir(); err == nil {
		real = append(real, d)
	}
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		real = append(real, filepath.Join(u.HomeDir, "Library", "Caches", "go-build"))
	}
	d := resolved(dir)
	for _, r := range real {
		if resolved(r) == d {
			return true
		}
	}
	return false
}

func resolved(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

// FileSink writes owner.json and state.json into Dir.
type FileSink struct{ Dir string }

func (s FileSink) WriteOwner(o ownerstate.Owner) error {
	return ownerstate.WriteJSON(s.Dir, ownerstate.OwnerFile, o)
}

func (s FileSink) WriteState(st ownerstate.State) error {
	return ownerstate.WriteJSON(s.Dir, ownerstate.StateFile, st)
}

func (s FileSink) Previous() (ownerstate.State, bool) {
	st, ok, err := ownerstate.ReadState(s.Dir)
	return st, ok && err == nil
}

// FileMode reads Dir/mode.
type FileMode struct{ Dir string }

func (m FileMode) Stat() ownerstate.ModeKey { return ownerstate.StatMode(m.Dir) }
func (m FileMode) Read() (string, bool, string) {
	return ownerstate.ReadMode(m.Dir)
}

type noPriority struct{}

func (noPriority) Background(bool) {}
