// Command micro measures the hot-path costs of a GOCACHEPROG put on this Mac: base64 encode and
// decode, SHA-256, ways to land a decoded body on APFS, and pipe throughput. Every case runs
// -reps times, interleaved round by round, and is reported as median and spread.
package main

import (
	"crypto/rand"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"pod-gocache-macos/bench/b64"
	"pod-gocache-macos/bench/internal/machstate"
	"pod-gocache-macos/bench/internal/stats"
)

// bench is one timed case; n is the number of decoded (binary) bytes it handles.
type bench struct {
	name  string
	n     int64
	setup func()
	run   func() map[string]float64
}

type result struct {
	name   string
	n      int64
	secs   []float64
	extras map[string][]float64
}

func measure(benches []bench, reps int) []result {
	res := make([]result, len(benches))
	for i, b := range benches {
		res[i] = result{name: b.name, n: b.n, extras: map[string][]float64{}}
	}
	for r := 0; r < reps; r++ {
		for k := range benches {
			i := (k + r) % len(benches) // rotate so no case always runs right after another
			b := benches[i]
			if b.setup != nil {
				b.setup()
			}
			t0 := time.Now()
			extra := b.run()
			res[i].secs = append(res[i].secs, time.Since(t0).Seconds())
			for k, v := range extra {
				res[i].extras[k] = append(res[i].extras[k], v)
			}
		}
		fmt.Fprintf(os.Stderr, "[micro] round %d/%d done (%s)\n", r+1, reps, machstate.Take())
	}
	return res
}

func printTable(title string, res []result) {
	fmt.Printf("\n### %s\n\n| case | MB | GB/s (decoded bytes): median [min..max] IQR | ms: median | extras (median) |\n|---|---|---|---|---|\n", title)
	for _, r := range res {
		gbps := make([]float64, len(r.secs))
		for i, s := range r.secs {
			gbps[i] = float64(r.n) / s / 1e9
		}
		var ex []string
		for k, v := range r.extras {
			ex = append(ex, fmt.Sprintf("%s %s", k, stats.Summarize(v).Format("%.1f")))
		}
		fmt.Printf("| %s | %.0f | %s | %.1f | %s |\n", r.name, float64(r.n)/1e6,
			stats.Summarize(gbps).Format("%.2f"), 1e3*stats.Summarize(r.secs).Median, strings.Join(ex, "; "))
	}
}

func input(path string, size int) []byte {
	if path != "" {
		b, err := os.ReadFile(path)
		if err != nil {
			fatal("%v", err)
		}
		return b
	}
	b := make([]byte, size)
	rand.Read(b)
	return b
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "pipe-child" {
		pipeChild(os.Args[2:])
		return
	}
	fs := flag.NewFlagSet("micro", flag.ExitOnError)
	reps := fs.Int("reps", 7, "repetitions per case")
	size := fs.Int("size", 254_000_000, "body size in bytes (the handlers archive is 240-254 MB)")
	in := fs.String("input", "", "use this file as the body instead of random bytes (e.g. a real -d archive)")
	dir := fs.String("dir", "/tmp/podgc-s0/micro", "scratch directory on the APFS volume under test")
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: micro b64|write|pipe|all [flags]")
		os.Exit(2)
	}
	what := os.Args[1]
	fs.Parse(os.Args[2:])
	raw := input(*in, *size)
	fmt.Printf("## micro %s\n\n%s; GOMAXPROCS default; NEON decoder active: %v; body %d bytes (%s)\n\nBefore: %s\n",
		what, machstate.Header(), b64.SIMD(), len(raw), map[bool]string{true: *in, false: "random"}[*in != ""], machstate.Take())
	if what == "b64" || what == "all" {
		printTable("base64 and hashing, in memory", measure(b64Benches(raw), *reps))
	}
	if what == "write" || what == "all" {
		if err := os.MkdirAll(*dir, 0o755); err != nil {
			fatal("%v", err)
		}
		printTable("landing a 254 MB body on APFS", measure(writeBenches(raw, *dir), *reps))
		os.RemoveAll(*dir)
	}
	if what == "pipe" || what == "all" {
		printTable("pipe parent -> child (child spawn excluded)", measure(pipeBenches(raw), *reps))
	}
	fmt.Printf("\nAfter: %s\n", machstate.Take())
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "micro: "+format+"\n", a...)
	os.Exit(1)
}
