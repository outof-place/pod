// Command pod-gocache is Pod's Go build cache: a GOCACHEPROG client over Go's
// native GOCACHE layout, and later a daemon that owns eviction.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// version is set at link time: -ldflags "-X main.version=<v>".
var version = "0.0.0-dev"

const (
	exitUsage       = 64 // EX_USAGE
	exitUnavailable = 69 // EX_UNAVAILABLE
)

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
		fmt.Fprintln(stderr, "pod-gocache daemon: not implemented")
		return exitUnavailable
	case "status":
		return runStatus(args[1:], stdout, stderr)
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
  pod-gocache daemon          cache daemon (not implemented yet)
  pod-gocache status [--json] cache status
  pod-gocache version         print the version
`)
}

func runStatus(args []string, stdout, stderr io.Writer) int {
	asJSON := false
	for _, a := range args {
		switch a {
		case "--json", "-json":
			asJSON = true
		default:
			usage(stderr)
			return exitUsage
		}
	}
	if asJSON {
		data, _ := json.Marshal(struct {
			Version string `json:"version"`
			Mode    string `json:"mode"`
		}{version, "standalone"})
		fmt.Fprintf(stdout, "%s\n", data)
		return 0
	}
	fmt.Fprintf(stdout, "pod-gocache %s: standalone (no daemon)\n", version)
	return 0
}
