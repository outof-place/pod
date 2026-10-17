// Command execcost measures what starting the GOCACHEPROG client costs each go invocation: the
// time from fork/exec to its capabilities line, for a freshly linked binary (first exec, which
// macOS may scan) and for later execs of the same file.
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"pod-gocache-macos/bench/internal/machstate"
	"pod-gocache-macos/bench/internal/stats"
)

// once starts bin, waits for the capabilities line, sends close and waits for exit.
func once(bin, dir string) (ready, total time.Duration) {
	cmd := exec.Command(bin, "-dir", dir)
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	t0 := time.Now()
	if err := cmd.Start(); err != nil {
		fatal("%v", err)
	}
	br := bufio.NewReader(out)
	if _, err := br.ReadString('\n'); err != nil {
		fatal("no capabilities line: %v", err)
	}
	ready = time.Since(t0)
	io.WriteString(in, "{\"ID\":1,\"Command\":\"close\"}\n\n")
	br.ReadString('\n')
	in.Close()
	cmd.Wait()
	return ready, time.Since(t0)
}

func main() {
	pkg := flag.String("pkg", ".", "bench module directory (cmd/passprog is built from here)")
	fresh := flag.Int("fresh", 5, "freshly linked binaries, each with a new code hash")
	later := flag.Int("later", 30, "execs of each binary after its first")
	dir := flag.String("dir", "/tmp/podgc-s0/execcost", "where the binaries go")
	flag.Parse()
	if err := os.MkdirAll(*dir, 0o755); err != nil {
		fatal("%v", err)
	}
	cache := filepath.Join(*dir, "gocache")
	os.MkdirAll(cache, 0o755)
	fmt.Printf("## exec cost of the GOCACHEPROG client\n\n%s\n\nBefore: %s\n\n", machstate.Header(), machstate.Take())
	var first, firstTotal, rest []float64
	var size int64
	for i := 0; i < *fresh; i++ {
		nonce := make([]byte, 16)
		rand.Read(nonce)
		bin := filepath.Join(*dir, fmt.Sprintf("passprog-%d", i))
		build := exec.Command("go", "build", "-o", bin, "-ldflags=-X main.nonce="+hex.EncodeToString(nonce), "./cmd/passprog")
		build.Dir = *pkg
		build.Env = append(os.Environ(), "GOEXPERIMENT=simd")
		if out, err := build.CombinedOutput(); err != nil {
			fatal("build: %v\n%s", err, out)
		}
		if st, err := os.Stat(bin); err == nil {
			size = st.Size()
		}
		r, t := once(bin, cache)
		first = append(first, ms(r))
		firstTotal = append(firstTotal, ms(t))
		for j := 0; j < *later; j++ {
			r, _ := once(bin, cache)
			rest = append(rest, ms(r))
		}
	}
	var trueMS []float64
	for j := 0; j < *later; j++ {
		t0 := time.Now()
		exec.Command("/usr/bin/true").Run()
		trueMS = append(trueMS, ms(time.Since(t0)))
	}
	fmt.Printf("Binary size %.1f MB.\n\n| exec | n | ms to capabilities: median [min..max] IQR | p90 ms |\n|---|---|---|---|\n", float64(size)/1e6)
	fmt.Printf("| first exec of a freshly linked client | %d | %s | %.2f |\n", len(first), stats.Summarize(first).Format("%.2f"), stats.Quantile(first, 0.9))
	fmt.Printf("| later execs of the same client | %d | %s | %.2f |\n", len(rest), stats.Summarize(rest).Format("%.2f"), stats.Quantile(rest, 0.9))
	fmt.Printf("| /usr/bin/true, fork+exec+exit (reference) | %d | %s | %.2f |\n", len(trueMS), stats.Summarize(trueMS).Format("%.2f"), stats.Quantile(trueMS, 0.9))
	fmt.Printf("\nFirst exec incl. close and exit: %s ms. After: %s\n", stats.Summarize(firstTotal).Format("%.2f"), machstate.Take())
	os.RemoveAll(*dir)
}

func ms(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e6 }

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "execcost: "+format+"\n", a...)
	os.Exit(1)
}
