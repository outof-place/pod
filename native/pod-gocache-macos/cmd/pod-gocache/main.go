// Command pod-gocache is Pod's Go build cache: a GOCACHEPROG client over Go's
// native GOCACHE layout, and the daemon that owns its eviction.
package main

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/daemon"
)

// version is set at link time: -ldflags "-X main.version=<v>".
var version = "0.0.0-dev"

const exitUsage = 64 // EX_USAGE

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return exitUsage
	}
	switch args[0] {
	case "prog":
		return runProg()
	case "daemon":
		return daemon.DaemonMain(context.Background(), args[1:], stderr, version)
	case "status":
		return daemon.StatusMain(args[1:], stdout, stderr, version)
	case "version":
		fmt.Fprintln(stdout, version)
		return 0
	default:
		usage(stderr)
		return exitUsage
	}
}

func usage(w io.Writer) {
	fmt.Fprint(w, `usage:
  pod-gocache prog            GOCACHEPROG client (GOCACHEPROG="<path> prog")
  pod-gocache daemon [--cache-dir <abs>] [--state-dir <abs>] [--mode observe]
                              the cache owner (observe until ~/.pod/gocache/mode says owner)
  pod-gocache status [--json] [--state-dir <abs>]
                              the daemon's last status; works with the daemon down
  pod-gocache version         print the version
`)
}
