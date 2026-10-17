package daemon

import (
	"context"
	"flag"
	"fmt"
	"io"
	"time"
)

// DaemonMain is `pod-gocache daemon [--cache-dir <abs>] [--state-dir <abs>]
// [--mode observe]`. The mode file decides observe or owner; --mode observe
// is a ceiling that keeps the daemon read-only whatever the file says.
func DaemonMain(ctx context.Context, args []string, stderr io.Writer, version string) int {
	fs := flag.NewFlagSet("daemon", flag.ContinueOnError)
	fs.SetOutput(stderr)
	cacheDir := fs.String("cache-dir", "", "absolute GOCACHE directory (default: os.UserCacheDir()/go-build)")
	stateDir := fs.String("state-dir", "", "absolute state directory (default: ~/.pod/gocache)")
	mode := fs.String("mode", "", `"observe" forces observe mode (read-only)`)
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return ExitUsage
	}
	if *mode != "" && *mode != "observe" {
		fmt.Fprintf(stderr, "pod-gocache daemon: --mode accepts only \"observe\"; owner mode is switched by the mode file\n")
		return ExitUsage
	}
	return Run(ctx, Config{CacheDir: *cacheDir, StateDir: *stateDir, Version: version, ObserveOnly: *mode == "observe"})
}

// StatusMain is `pod-gocache status [--json] [--state-dir <abs>]`. It reads
// the state directory only, so it works with the daemon down. It exits 0 with
// valid JSON unless state.json exists but can't be read or parsed (74);
// neverRan marks a daemon that never ran.
func StatusMain(args []string, stdout, stderr io.Writer, version string) int {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "print state.json plus heartbeatFresh")
	stateDir := fs.String("state-dir", "", "absolute state directory (default: ~/.pod/gocache)")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return ExitUsage
	}
	dir := *stateDir
	var err error
	if dir == "" {
		dir, err = DefaultStateDir()
	} else {
		dir, err = absClean("--state-dir", dir)
	}
	if err != nil {
		fmt.Fprintf(stderr, "pod-gocache status: %v\n", err)
		return exitFor(err)
	}
	st, err := ReadStatus(dir, time.Now())
	if err != nil {
		fmt.Fprintf(stderr, "pod-gocache status: %v\n", err)
		return ExitIO
	}
	if st.NeverRan {
		st.Version, st.Mode = version, "standalone"
	}
	PrintStatus(stdout, st, *asJSON)
	return ExitOK
}
