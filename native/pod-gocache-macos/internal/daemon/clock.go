package daemon

import (
	"encoding/binary"
	"syscall"
	"time"
	_ "unsafe" // runtime.nanotime
)

// Clock has the two clocks the daemon needs: wall time (mtimes are wall
// time) and a monotonic clock that stops while the Mac sleeps, plus the boot
// time that tells a reboot from a sleep.
type Clock interface {
	Wall() time.Time
	Mono() time.Duration
	Boot() int64 // unix microseconds; 0 when unknown
}

// RealClock reads the system clocks. Mono is awake time since boot
// (mach_absolute_time on darwin, stopped during sleep), the same in every
// process, so a restarted daemon can still see a sleep it missed.
type RealClock struct{}

func NewRealClock() *RealClock { return &RealClock{} }

// The runtime keeps this linkname working for outside packages (go.dev/issue/67401).
//
//go:linkname nanotime runtime.nanotime
func nanotime() int64

func (c *RealClock) Wall() time.Time     { return time.Now().Round(0) }
func (c *RealClock) Mono() time.Duration { return time.Duration(nanotime()) }

// Boot reads kern.boottime, a struct timeval (int64 seconds, int32
// microseconds); syscall.Sysctl drops a trailing NUL byte.
func (c *RealClock) Boot() int64 {
	raw, err := syscall.Sysctl("kern.boottime")
	if err != nil || len(raw) < 12 {
		return 0
	}
	b := []byte(raw)
	return int64(binary.LittleEndian.Uint64(b[:8]))*1e6 + int64(int32(binary.LittleEndian.Uint32(b[8:12])))
}

// bootSlack absorbs the small shifts of kern.boottime when the clock is
// adjusted; a reboot moves it by at least the time the Mac was off.
const bootSlack = int64(time.Minute / time.Microsecond)

// rebooted reports whether the system booted again since prev (both unix
// microseconds, 0 unknown).
func rebooted(prev, now int64) bool {
	return prev != 0 && now != 0 && (now-prev > bootSlack || prev-now > bootSlack)
}

// jump is a forward step of the wall clock that awake time did not follow
// (sleep, or a clock set forward): entries last used before Boundary get
// Credit taken off their age.
type jump struct {
	Boundary int64 // wall ns
	Credit   int64 // ns
}

// jumps keeps recent forward jumps; ages are measured in awake time.
type jumps struct {
	list     []jump
	lastWall int64
	lastMono time.Duration
	started  bool
}

const maxJumps = 32

// observe compares the two clocks since the last call and returns the jump
// it found in ns (> 0 forward, < 0 backward, 0 none).
func (j *jumps) observe(wall int64, mono time.Duration, tolerance time.Duration) int64 {
	if !j.started {
		j.started, j.lastWall, j.lastMono = true, wall, mono
		return 0
	}
	dMono := int64(mono - j.lastMono)
	diff := (wall - j.lastWall) - dMono
	j.lastWall, j.lastMono = wall, mono
	switch {
	case diff > int64(tolerance):
		j.list = append(j.list, jump{Boundary: wall - dMono, Credit: diff})
		if len(j.list) > maxJumps {
			j.list[1].Credit += j.list[0].Credit
			j.list = j.list[1:]
		}
		return diff
	case diff < -int64(tolerance):
		return diff
	}
	return 0
}

// resume accounts for the gap between the previous run's last status and
// this start: a forward jump there (a sleep while no daemon ran, or the clock
// set ahead) is credited to everything used before now. The caller rules out
// a reboot first; awake time going backwards means one too.
func (j *jumps) resume(prevWall int64, prevMono time.Duration, wall int64, mono time.Duration, tolerance time.Duration) int64 {
	if prevWall == 0 || prevMono > mono {
		return 0
	}
	diff := (wall - prevWall) - int64(mono-prevMono)
	if diff <= int64(tolerance) {
		return 0
	}
	j.list = append(j.list, jump{Boundary: wall, Credit: diff})
	return diff
}

// credit is how much of an entry's wall age was slept through.
func (j *jumps) credit(recency int64) int64 {
	var c int64
	for _, x := range j.list {
		if recency < x.Boundary {
			c += x.Credit
		}
	}
	return c
}

// age is the awake time since recency.
func (j *jumps) age(wall, recency int64) time.Duration {
	return time.Duration(wall - recency - j.credit(recency))
}

// prune drops jumps older than horizon (beyond every age bucket).
func (j *jumps) prune(wall int64, horizon time.Duration) {
	i := 0
	for i < len(j.list) && wall-j.list[i].Boundary > int64(horizon) {
		i++
	}
	j.list = j.list[i:]
}

// rusage is the daemon's own CPU time and peak RSS.
func rusage() (cpu time.Duration, maxRSS int64) {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0, 0
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano()), ru.Maxrss
}
