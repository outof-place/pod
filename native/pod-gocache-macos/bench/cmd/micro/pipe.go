package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"pod-gocache-macos/bench/b64"
)

// pipeBenches send one quoted base64 body through a pipe(2) to a child, as cmd/go does to its
// GOCACHEPROG. The child is started and ready before the clock runs.
func pipeBenches(raw []byte) []bench {
	n := int64(len(raw))
	enc := make([]byte, base64.StdEncoding.EncodedLen(len(raw)))
	base64.StdEncoding.Encode(enc, raw)
	buf32k := make([]byte, 32<<10)
	var child *pipeProc
	start := func(consume string) func() {
		return func() { child = startPipeChild(consume, n) }
	}
	goShaped := func() map[string]float64 {
		// cmd/go: bufio.NewWriter(stdin) (4 KiB), '"', base64.NewEncoder over io.Copy(file), '"\n'.
		w := bufio.NewWriter(child.stdin)
		w.WriteByte('"')
		e := base64.NewEncoder(base64.StdEncoding, w)
		io.CopyBuffer(e, onlyReader{bytes.NewReader(raw)}, buf32k)
		e.Close()
		w.WriteString("\"\n")
		w.Flush()
		return child.finish()
	}
	preEncoded := func(chunk int) func() map[string]float64 {
		return func() map[string]float64 {
			child.stdin.Write([]byte{'"'})
			for i := 0; i < len(enc); i += chunk {
				child.stdin.Write(enc[i:min(i+chunk, len(enc))])
			}
			child.stdin.Write([]byte("\"\n"))
			return child.finish()
		}
	}
	return []bench{
		{name: "cmd/go-shaped producer (encode + 4 KiB writes) -> child scanning for the quote", n: n, setup: start("discard"), run: goShaped},
		{name: "cmd/go-shaped producer -> child decoding with NEON", n: n, setup: start("neon"), run: goShaped},
		{name: "cmd/go-shaped producer -> child decoding with stdlib", n: n, setup: start("stdlib"), run: goShaped},
		{name: "pre-encoded, 4 KiB writes -> child scanning (pipe only, cmd/go's write size)", n: n, setup: start("discard"), run: preEncoded(4 << 10)},
		{name: "pre-encoded, 64 KiB writes -> child scanning", n: n, setup: start("discard"), run: preEncoded(64 << 10)},
		{name: "pre-encoded, 1 MiB writes -> child scanning", n: n, setup: start("discard"), run: preEncoded(1 << 20)},
	}
}

type pipeProc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}

func startPipeChild(consume string, n int64) *pipeProc {
	cmd := exec.Command(os.Args[0], "pipe-child", "-consume", consume, "-size", strconv.FormatInt(n, 10))
	cmd.Stderr = os.Stderr
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		fatal("%v", err)
	}
	p := &pipeProc{cmd: cmd, stdin: in, stdout: bufio.NewReader(out)}
	if l, err := p.stdout.ReadString('\n'); err != nil || l != "ready\n" {
		fatal("pipe child did not start: %q %v", l, err)
	}
	return p
}

// finish waits for the child to report that it consumed the whole body.
func (p *pipeProc) finish() map[string]float64 {
	l, err := p.stdout.ReadString('\n')
	p.stdin.Close()
	p.cmd.Wait()
	if err != nil {
		fatal("pipe child: %v", err)
	}
	var reads, decoded int64
	fmt.Sscanf(strings.TrimSpace(l), "done %d %d", &reads, &decoded)
	return map[string]float64{"reads": float64(reads)}
}

func pipeChild(args []string) {
	fs := flag.NewFlagSet("pipe-child", flag.ExitOnError)
	consume := fs.String("consume", "discard", "discard | neon | stdlib")
	size := fs.Int64("size", 0, "decoded body size")
	fs.Parse(args)
	dec := map[string]decodeFunc{"neon": b64.Decode, "stdlib": base64.StdEncoding.Decode}[*consume]
	buf := make([]byte, 1<<20)
	out := make([]byte, 1<<20)
	os.Stdout.WriteString("ready\n")
	var reads, decoded int64
	r, w := 0, 0
	inBody := false
	for {
		k, err := os.Stdin.Read(buf[w:])
		reads++
		w += k
		if !inBody && w > r && buf[r] == '"' {
			inBody = true
			r++
		}
		avail := buf[r:w]
		q := bytes.IndexByte(avail, '"')
		end := len(avail) &^ 3
		if q >= 0 {
			end = q
		}
		if dec != nil {
			m, derr := dec(out, avail[:end])
			if derr != nil {
				fmt.Fprintln(os.Stderr, "pipe child decode:", derr)
				os.Exit(1)
			}
			decoded += int64(m)
		}
		if q >= 0 {
			break
		}
		r += end
		copy(buf, buf[r:w]) // at most 3 bytes
		w -= r
		r = 0
		if err != nil {
			fmt.Fprintln(os.Stderr, "pipe child: stdin ended before the closing quote")
			os.Exit(1)
		}
	}
	if dec != nil && decoded != *size {
		fmt.Fprintf(os.Stderr, "pipe child: decoded %d, want %d\n", decoded, *size)
		os.Exit(1)
	}
	fmt.Printf("done %d %d\n", reads, decoded)
}
