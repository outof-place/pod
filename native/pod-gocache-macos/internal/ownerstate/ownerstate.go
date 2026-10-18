// Package ownerstate holds the daemon's files in its state directory
// (~/.pod/gocache): owner.json (the heartbeat other trimmers obey),
// state.json (full status), the mode switch, and the crash-loop record.
// owner.json and state.json are frozen contracts; see the module README.
package ownerstate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// File names inside the state directory.
const (
	OwnerFile = "owner.json"
	StateFile = "state.json"
	ModeFile  = "mode"
	LockFile  = "daemon.lock"
	StartFile = "starts"
	LogFile   = "daemon.log"
)

// Schema is owner.json's schema number.
const Schema = 1

// FreshFor is how old (in either direction) a heartbeat may be and still mean
// "a daemon owns the cache".
const FreshFor = 120 * time.Second

// Modes.
const (
	ModeObserve = "observe"
	ModeOwner   = "owner"
)

// Owner is owner.json. Times are unix seconds.
type Owner struct {
	Schema      int    `json:"schema"`
	Version     string `json:"version"`
	PID         int    `json:"pid"`
	StartedAt   int64  `json:"startedAt"`
	HeartbeatAt int64  `json:"heartbeatAt"`
	Mode        string `json:"mode"`
	CacheDir    string `json:"cacheDir"`
	BudgetBytes int64  `json:"budgetBytes"`
	TargetBytes *int64 `json:"targetBytes"`
}

// Evictions counts what the daemon deleted since it started.
type Evictions struct {
	Count  int64 `json:"count"`
	Bytes  int64 `json:"bytes"`
	LastAt int64 `json:"lastAt"`
}

// State is state.json. Byte counts are null until the first full index.
type State struct {
	Version         string    `json:"version"`
	Mode            string    `json:"mode"`
	CacheDir        string    `json:"cacheDir"`
	SizeBytes       *int64    `json:"sizeBytes"`
	Entries         *int64    `json:"entries"`
	BudgetBytes     int64     `json:"budgetBytes"`
	TargetBytes     *int64    `json:"targetBytes"`
	FreeDiskBytes   *int64    `json:"freeDiskBytes"`
	WouldEvictBytes *int64    `json:"wouldEvictBytes"`
	Evictions       Evictions `json:"evictions"`
	OldestRecencyAt *int64    `json:"oldestRecencyAt"`
	HeartbeatAt     int64     `json:"heartbeatAt"`
	Extra           Extra     `json:"extra"`
}

// Extra is the open part of state.json; fields may be added, never renamed.
type Extra struct {
	PID            int        `json:"pid,omitempty"`
	StartedAt      int64      `json:"startedAt,omitempty"`
	Phase          string     `json:"phase,omitempty"`
	Reasons        []string   `json:"reasons,omitempty"`
	Error          string     `json:"error,omitempty"`
	ModeRequested  string     `json:"modeRequested,omitempty"`
	ModeReason     string     `json:"modeReason,omitempty"`
	IndexedBuckets int        `json:"indexedBuckets,omitempty"`
	Actions        int        `json:"actions,omitempty"`
	Outputs        int        `json:"outputs,omitempty"`
	Tier           string     `json:"tier,omitempty"`
	WindowSeconds  int64      `json:"windowSeconds,omitempty"`
	WindowReason   string     `json:"windowReason,omitempty"`
	GraceUntil     int64      `json:"graceUntil,omitempty"`
	ProtectedBytes int64      `json:"protectedBytes"`
	EvictableBytes int64      `json:"evictableBytes"`
	FutureBytes    int64      `json:"futureBytes,omitempty"`
	StuckBytes     int64      `json:"stuckBytes,omitempty"`
	UnmanagedBytes int64      `json:"unmanagedBytes,omitempty"`
	TempBytes      int64      `json:"clientTempBytes,omitempty"`
	TempSwept      *Evictions `json:"clientTempSwept,omitempty"`
	UnmanagedFiles int        `json:"unmanagedFiles,omitempty"`
	// RootUnmanaged* count everything at the cache root besides the buckets
	// (fuzz/, README, trim.txt, strays); FuzzBytes is the fuzz/ part.
	RootUnmanagedBytes int64 `json:"rootUnmanagedBytes,omitempty"`
	RootUnmanagedFiles int   `json:"rootUnmanagedFiles,omitempty"`
	FuzzBytes          int64 `json:"fuzzBytes,omitempty"`
	// VanishedBytes are entries deleted by something other than this daemon
	// since it started (go clean, Go's own trim, an old trimmer).
	VanishedBytes  int64    `json:"vanishedBytes,omitempty"`
	VanishedLastAt int64    `json:"vanishedLastAt,omitempty"`
	Policy         string   `json:"policy,omitempty"`
	TrimWrittenAt  int64    `json:"trimWrittenAt,omitempty"`
	TrimError      string   `json:"trimError,omitempty"`
	Restarts       int      `json:"restarts,omitempty"`
	Episode        *Episode `json:"episode,omitempty"`
	Scan           Scan     `json:"scan"`
	CPUSeconds     float64  `json:"cpuSeconds,omitempty"`
	MaxRSSBytes    int64    `json:"maxRssBytes,omitempty"`
	LastClockJump  int64    `json:"lastClockJumpSeconds,omitempty"`
	// SleepCredits carries recent sleeps across restarts: [boundary unix ns,
	// credit ns] pairs. Internal to the daemon.
	SleepCredits [][2]int64 `json:"sleepCredits,omitempty"`
	// LastWallNs and LastAwakeNs are both clocks at this write, so the next
	// start can tell how long the Mac slept while no daemon ran; BootTimeUs
	// (kern.boottime) tells it a reboot happened instead.
	LastWallNs  int64 `json:"lastWallNs,omitempty"`
	LastAwakeNs int64 `json:"lastAwakeNs,omitempty"`
	BootTimeUs  int64 `json:"bootTimeUs,omitempty"`
	// Live is the state shared with GOCACHEPROG clients (S9).
	Live *Live `json:"live,omitempty"`
}

// Live describes the state the daemon shares with its clients.
type Live struct {
	Dir       string `json:"dir,omitempty"`
	Reason    string `json:"reason,omitempty"` // why nothing is shared now
	Entries   int    `json:"entries"`          // -a entries published
	Slots     int    `json:"slots"`            // index table size
	Refused   int    `json:"refused,omitempty"`
	Clients   int    `json:"clients"` // live client sessions
	Pinning   int    `json:"pinningProcesses"`
	Overflow  int    `json:"overflowedClients,omitempty"`
	Pinned    int64  `json:"pinnedBytes"`
	OverCap   int64  `json:"pinnedOverCapBytes,omitempty"`
	GaveWay   int64  `json:"pinnedGaveWayBytes,omitempty"`
	Kept      uint64 `json:"pinnedKept"` // removals skipped for a pin since start
	Records   uint64 `json:"records"`
	Rereads   uint64 `json:"rereads"`
	Handshake uint64 `json:"dyingBatches"`
}

// Episode is a low-disk episode in progress.
type Episode struct {
	EvictedBytes   int64 `json:"evictedBytes"`
	AllowanceBytes int64 `json:"allowanceBytes"`
	ConfirmedBytes int64 `json:"confirmedBytes"`
	RoomBytes      int64 `json:"roomBytes"`
	PausedUntil    int64 `json:"pausedUntil,omitempty"`
	NoEffectBytes  int64 `json:"noEffectEvictedBytes,omitempty"`
	NoEffectFreeUp int64 `json:"noEffectFreeDeltaBytes,omitempty"`
}

// Scan counts filesystem calls since start, so cost scales can be checked.
type Scan struct {
	Lstats     uint64 `json:"lstats"`
	Reads      uint64 `json:"reads"`
	Lists      uint64 `json:"lists"`
	Relists    uint64 `json:"relists"`
	LastFullAt int64  `json:"lastFullAt,omitempty"`
}

// Fresh applies the reader rule's time part: |now - heartbeatAt| <= 120 s.
func Fresh(heartbeatAt int64, now time.Time) bool {
	d := now.Unix() - heartbeatAt
	return heartbeatAt > 0 && d <= int64(FreshFor/time.Second) && d >= -int64(FreshFor/time.Second)
}

// WriteAtomic replaces dir/name with data: a temp file beside it, fsync,
// rename. Readers see the old file or the new one, never a torn one.
func WriteAtomic(dir, name string, data []byte) error {
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.tmp.%d", name, os.Getpid()))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		// Plain fsync: f.Sync is F_FULLFSYNC on darwin, a drive cache flush
		// every heartbeat that stalls builds' I/O. A torn file after power
		// loss reads as "no owner", which is safe.
		err = syscall.Fsync(int(f.Fd()))
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, filepath.Join(dir, name))
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// WriteJSON marshals v and writes it atomically.
func WriteJSON(dir, name string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return WriteAtomic(dir, name, append(data, '\n'))
}

// CleanTemps removes temp files a killed daemon left in dir.
func CleanTemps(dir string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		n := e.Name()
		if strings.HasPrefix(n, ".") && strings.Contains(n, ".tmp.") && e.Type().IsRegular() {
			os.Remove(filepath.Join(dir, n))
		}
	}
}

// ReadState reads state.json; ok is false when it doesn't exist.
func ReadState(dir string) (State, bool, error) {
	var s State
	data, err := os.ReadFile(filepath.Join(dir, StateFile))
	if errors.Is(err, os.ErrNotExist) {
		return s, false, nil
	}
	if err != nil {
		return s, false, err
	}
	return s, true, json.Unmarshal(data, &s)
}

// ReadOwner reads owner.json; ok is false when it doesn't exist.
func ReadOwner(dir string) (Owner, bool, error) {
	var o Owner
	data, err := os.ReadFile(filepath.Join(dir, OwnerFile))
	if errors.Is(err, os.ErrNotExist) {
		return o, false, nil
	}
	if err != nil {
		return o, false, err
	}
	return o, true, json.Unmarshal(data, &o)
}
