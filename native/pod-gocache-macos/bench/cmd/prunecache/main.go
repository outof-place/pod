// Command prunecache shrinks an APFS clone of a GOCACHE to the entries a set of passprog logs
// used: every -a a get or put named, and the output it references. Everything else in the
// buckets goes, so the clone stops holding blocks the live cache deletes later. It refuses the
// real cache.
package main

import (
	"bytes"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"pod-gocache-macos/bench/internal/proglog"
)

func main() {
	dir := flag.String("cache", "", "the clone to prune")
	flag.Parse()
	if *dir == "" || flag.NArg() == 0 {
		fatal("usage: prunecache -cache <clone> <passprog log>...")
	}
	abs, err := filepath.EvalSymlinks(*dir)
	if err != nil {
		fatal("%v", err)
	}
	home, _ := os.UserHomeDir()
	if real, err := filepath.EvalSymlinks(filepath.Join(home, "Library", "Caches", "go-build")); err == nil && real == abs {
		fatal("refusing the real cache %s", abs)
	}
	keep := map[string]bool{}
	for _, log := range flag.Args() {
		procs, err := proglog.Read(log)
		if err != nil {
			fatal("%s: %v", log, err)
		}
		for _, p := range procs {
			for _, e := range p.Events {
				if e.Action != "" {
					keep[e.Action[:2]+"/"+e.Action+"-a"] = true
				}
			}
		}
	}
	// Outputs: whatever each kept -a references.
	for rel := range keep {
		data, err := os.ReadFile(filepath.Join(abs, rel))
		if err != nil || len(data) < 132 || !bytes.HasPrefix(data, []byte("v1 ")) {
			continue
		}
		out := string(data[68:132])
		if _, err := hex.DecodeString(out); err == nil {
			keep[out[:2]+"/"+out+"-d"] = true
		}
	}
	removed, kept := 0, 0
	for b := 0; b < 256; b++ {
		bucket := fmt.Sprintf("%02x", b)
		names, _ := os.ReadDir(filepath.Join(abs, bucket))
		for _, n := range names {
			rel := bucket + "/" + n.Name()
			if keep[rel] {
				kept++
				continue
			}
			if !strings.HasSuffix(n.Name(), "-a") && !strings.HasSuffix(n.Name(), "-d") {
				continue
			}
			if err := os.RemoveAll(filepath.Join(abs, rel)); err == nil {
				removed++
			}
		}
	}
	fmt.Printf("prunecache: kept %d files, removed %d\n", kept, removed)
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "prunecache: "+format+"\n", a...)
	os.Exit(1)
}
