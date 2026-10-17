package daemon

import "syscall"

// From <sys/resource.h>: PRIO_DARWIN_BG on the calling thread "lowers CPU,
// disk IO, and networking priorities until reset".
const (
	prioDarwinThread = 3
	prioDarwinBG     = 0x1000
)

// ThreadPriority puts the calling OS thread in the darwin background band.
// The loop goroutine is locked to its thread, so only the scan and removal
// work is throttled, never a go build, and not the heartbeat writes.
type ThreadPriority struct{}

func (ThreadPriority) Background(on bool) {
	v := 0
	if on {
		v = prioDarwinBG
	}
	syscall.Setpriority(prioDarwinThread, 0, v)
}

// threadIsBackground reads the calling thread's background state.
func threadIsBackground() bool {
	v, err := syscall.Getpriority(prioDarwinThread, 0)
	return err == nil && v != 0
}
