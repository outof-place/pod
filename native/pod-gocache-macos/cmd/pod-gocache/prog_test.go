package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/fakego"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/protocol"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/store"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/trace"
)

var binPath string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "pgc-cmd-bin-")
	if err != nil {
		panic(err)
	}
	binPath = filepath.Join(dir, "pod-gocache")
	build := exec.Command("go", "build", "-o", binPath, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "build:", err)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func actionID(n int) []byte {
	sum := sha256.Sum256([]byte(fmt.Sprint("action", n)))
	return sum[:]
}

// sandbox is a temp GOCACHE, trace dir and HOME for one client.
type sandbox struct {
	gocache, trace, home string
}

func newSandbox(t *testing.T) sandbox {
	t.Helper()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	sb := sandbox{filepath.Join(root, "gocache"), filepath.Join(root, "trace"), filepath.Join(root, "home")}
	os.MkdirAll(sb.gocache, 0o777)
	os.MkdirAll(sb.home, 0o777)
	return sb
}

// client is the real binary under a fake go.
type client struct {
	cmd    *exec.Cmd
	conn   *fakego.Conn
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr *bytes.Buffer
}

func startClient(t *testing.T, sb sandbox) *client {
	t.Helper()
	cmd := exec.Command(binPath, "prog")
	cmd.Env = []string{"GOCACHE=" + sb.gocache, "POD_GOCACHE_TRACE_DIR=" + sb.trace, "HOME=" + sb.home, "PATH=/usr/bin:/bin"}
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	conn, err := fakego.Start(stdout, stdin, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return &client{cmd: cmd, conn: conn, stdin: stdin, stdout: stdout, stderr: &stderr}
}

// wait requires a clean exit within a few seconds and silent stderr.
func (c *client) wait(t *testing.T) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- c.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("client exit: %v (stderr %q)", err, c.stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("client did not exit")
	}
	if c.stderr.Len() > 0 {
		t.Fatalf("client wrote to stderr: %q", c.stderr.String())
	}
}

func traceOps(t *testing.T, dir string) map[trace.Op]int {
	t.Helper()
	recs, _ := trace.ReadDir(dir)
	m := map[trace.Op]int{}
	for _, r := range recs {
		m[r.Op]++
	}
	return m
}

func noTempFiles(t *testing.T, dir string) {
	t.Helper()
	filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(d.Name(), ".pgc-tmp.") {
			t.Errorf("temp file left: %s", path)
		}
		return nil
	})
}

func checkHit(t *testing.T, res *fakego.Response, body []byte) {
	t.Helper()
	out := sha256.Sum256(body)
	if res.Miss || !bytes.Equal(res.OutputID, out[:]) || res.Size != int64(len(body)) || res.Time == nil {
		t.Fatalf("bad hit: %+v", res)
	}
	got, err := os.ReadFile(res.DiskPath)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("DiskPath %s: %v", res.DiskPath, err)
	}
}

// inProcess runs serve over pipes, so the race detector sees the serve loop.
func inProcess(t *testing.T, sb sandbox) (*fakego.Conn, chan bool) {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	w := protocol.NewWriter(outW)
	w.Hello()
	go w.Flush()
	done := make(chan bool, 1)
	go func() {
		closed := serve(inR, w, store.Open(sb.gocache), trace.New(sb.trace))
		outW.Close()
		done <- closed
	}()
	conn, err := fakego.Start(outR, inW, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return conn, done
}

// Many goroutines put and get at once, as go's builder does: every response
// reaches the request that asked for it, with the right content.
func TestConcurrentRequests(t *testing.T) {
	sb := newSandbox(t)
	conn, done := inProcess(t, sb)
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for g := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := rand.New(rand.NewPCG(uint64(g), 1))
			for i := range 40 {
				n := g*1000 + i
				size := []int{0, 1, 2, 3, 100, 70_000, 1 << 20}[r.IntN(7)]
				body := make([]byte, size)
				for j := range body {
					body[j] = byte(r.Uint32())
				}
				pres, err := conn.Put(actionID(n), body)
				if err != nil {
					errs <- fmt.Errorf("put %d: %v", n, err)
					return
				}
				if got, _ := os.ReadFile(pres.DiskPath); !bytes.Equal(got, body) {
					errs <- fmt.Errorf("put %d: DiskPath content differs", n)
					return
				}
				gres, err := conn.Get(actionID(n))
				out := sha256.Sum256(body)
				if err != nil || gres.Miss || !bytes.Equal(gres.OutputID, out[:]) || gres.DiskPath != pres.DiskPath {
					errs <- fmt.Errorf("get %d: %+v %v", n, gres, err)
					return
				}
				if m, err := conn.Get(actionID(-n - 1)); err != nil || !m.Miss {
					errs <- fmt.Errorf("unknown get %d: %+v %v", n, m, err)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	if closed := <-done; !closed {
		t.Fatal("serve did not see close")
	}
	if err := conn.Fatal(); err != nil {
		t.Fatal(err)
	}
	noTempFiles(t, sb.gocache)
}

// signalReader closes started on its first Read.
type signalReader struct {
	r       io.Reader
	once    sync.Once
	started chan struct{}
}

func (s *signalReader) Read(p []byte) (int, error) {
	s.once.Do(func() { close(s.started) })
	time.Sleep(time.Millisecond) // stretch the stream so close queues behind it
	return s.r.Read(p)
}

// Close called while a put is still streaming queues behind it, as go's
// writeMu orders them: the put completes and its file exists after close.
func TestCloseWithPutInFlight(t *testing.T) {
	sb := newSandbox(t)
	c := startClient(t, sb)
	body := bytes.Repeat([]byte("0123456789abcdef"), 1<<18) // 4 MiB
	out := sha256.Sum256(body)
	sr := &signalReader{r: bytes.NewReader(body), started: make(chan struct{})}
	type result struct {
		res *fakego.Response
		err error
	}
	putDone := make(chan result, 1)
	go func() {
		res, err := c.conn.PutStream(actionID(1), out[:], int64(len(body)), sr)
		putDone <- result{res, err}
	}()
	<-sr.started
	if err := c.conn.Close(); err != nil {
		t.Fatal(err)
	}
	r := <-putDone
	if r.err != nil {
		t.Fatalf("put in flight at close: %v", r.err)
	}
	if got, err := os.ReadFile(r.res.DiskPath); err != nil || !bytes.Equal(got, body) {
		t.Fatalf("DiskPath after close: %v", err)
	}
	c.wait(t)
	if err := c.conn.Fatal(); err != nil {
		t.Fatal(err)
	}
	noTempFiles(t, sb.gocache)
	if ops := traceOps(t, sb.trace); ops[trace.OpClose] != 1 || ops[trace.OpPutStored] != 1 {
		t.Errorf("trace: %v", ops)
	}
}

// Garbage between requests is skipped, a broken put body gets an error reply,
// and the client keeps serving: it never exits before close.
func TestGarbageInput(t *testing.T) {
	sb := newSandbox(t)
	c := startClient(t, sb)
	for _, junk := range []string{
		"garbage\n", "{\"ID\":\n", "\x00\x01\x02\n", strings.Repeat("y", 200_000) + "\n", "[1,2,3]\n",
		`{"ID":1000,"Command":"put","ActionID":"` + strings.Repeat("A", 43) + `=","OutputID":"` + strings.Repeat("A", 43) + `=","BodySize":3}` + "\n\n\"****\"\n",
	} {
		if err := c.conn.WriteRaw([]byte(junk)); err != nil {
			t.Fatal(err)
		}
	}
	if res, err := c.conn.Get(actionID(1)); err != nil || !res.Miss {
		t.Fatalf("get after garbage: %+v %v", res, err)
	}
	body := []byte("still serving")
	if _, err := c.conn.Put(actionID(2), body); err != nil {
		t.Fatal(err)
	}
	res, err := c.conn.Get(actionID(2))
	if err != nil {
		t.Fatal(err)
	}
	checkHit(t, res, body)
	if err := c.conn.Close(); err != nil {
		t.Fatal(err)
	}
	c.wait(t)
	// The broken put's reply has an ID go never sent; fakego flags it as go would.
	if err := c.conn.Fatal(); err == nil || !strings.Contains(err.Error(), "unknown request ID 1000") {
		t.Fatalf("broken put was not answered with an error: %v", err)
	}
	noTempFiles(t, sb.gocache)
}

// go killed mid-put: stdin ends inside the body. The client exits 0 at once,
// silently, leaving no partial file.
func TestEOFMidBody(t *testing.T) {
	sb := newSandbox(t)
	c := startClient(t, sb)
	body := bytes.Repeat([]byte{7}, 3<<20)
	out := sha256.Sum256(body)
	var raw bytes.Buffer
	json.NewEncoder(&raw).Encode(fakego.Request{ID: 1, Command: "put", ActionID: actionID(1), OutputID: out[:], BodySize: int64(len(body))})
	raw.WriteString("\n\"")
	raw.WriteString(strings.Repeat("BwcH", 1<<19))
	c.conn.WriteRaw(raw.Bytes())
	c.stdin.Close()
	c.wait(t)
	noTempFiles(t, sb.gocache)
	if _, err := os.Stat(filepath.Join(sb.gocache, fmt.Sprintf("%02x", out[0]), fmt.Sprintf("%x-d", out))); err == nil {
		t.Fatal("partial output in the store")
	}
	if ops := traceOps(t, sb.trace); ops[trace.OpEOF] != 1 || ops[trace.OpStart] != 1 {
		t.Fatalf("trace: %v", ops)
	}
}

// go list exits without close: EOF is a normal end.
func TestEOFWithoutClose(t *testing.T) {
	sb := newSandbox(t)
	c := startClient(t, sb)
	if res, err := c.conn.Get(actionID(1)); err != nil || !res.Miss {
		t.Fatal(res, err)
	}
	c.stdin.Close()
	c.wait(t)
	if ops := traceOps(t, sb.trace); ops[trace.OpEOF] != 1 || ops[trace.OpGetMiss] != 1 {
		t.Fatalf("trace: %v", ops)
	}
}

func TestKillSwitchSkipsTrace(t *testing.T) {
	sb := newSandbox(t)
	os.MkdirAll(filepath.Join(sb.home, ".pod", "gocache"), 0o700)
	os.WriteFile(filepath.Join(sb.home, ".pod", "gocache", "disabled"), nil, 0o600)
	c := startClient(t, sb)
	body := []byte("plain disk cache")
	c.conn.Put(actionID(1), body)
	res, err := c.conn.Get(actionID(1))
	if err != nil {
		t.Fatal(err)
	}
	checkHit(t, res, body)
	c.conn.Close()
	c.wait(t)
	if _, err := os.Stat(sb.trace); err == nil {
		t.Fatal("trace written with the kill switch on")
	}
}

// Ctrl-C reaches the whole process group; like go, the client keeps serving
// so go can finish and close it.
func TestInterruptIgnored(t *testing.T) {
	sb := newSandbox(t)
	c := startClient(t, sb)
	c.cmd.Process.Signal(syscall.SIGINT)
	c.cmd.Process.Signal(syscall.SIGQUIT)
	time.Sleep(50 * time.Millisecond)
	if res, err := c.conn.Get(actionID(1)); err != nil || !res.Miss {
		t.Fatalf("after SIGINT: %+v %v", res, err)
	}
	c.conn.Close()
	c.wait(t)
}

// If go is gone and its end of stdout closed, the client exits normally
// instead of dying from SIGPIPE.
func TestStdoutGoneExitsCleanly(t *testing.T) {
	sb := newSandbox(t)
	c := startClient(t, sb)
	c.stdout.Close()
	time.Sleep(20 * time.Millisecond)
	c.conn.WriteRaw([]byte(`{"ID":5,"Command":"get","ActionID":"` + strings.Repeat("A", 43) + `="}` + "\n"))
	c.stdin.Close()
	c.wait(t)
}

func TestCLI(t *testing.T) {
	run := func(args ...string) (string, string, int) {
		cmd := exec.Command(binPath, args...)
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		err := cmd.Run()
		code := 0
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
		return out.String(), errb.String(), code
	}
	if out, _, code := run("version"); code != 0 || strings.TrimSpace(out) != version {
		t.Errorf("version: %q %d", out, code)
	}
	out, _, code := run("status", "--json")
	var st map[string]any
	if err := json.Unmarshal([]byte(out), &st); err != nil || code != 0 || st["version"] != version || st["mode"] != "standalone" || len(st) != 2 {
		t.Errorf("status --json: %q %d %v", out, code, err)
	}
	if _, errOut, code := run("daemon"); code != exitUnavailable || !strings.Contains(errOut, "not implemented") {
		t.Errorf("daemon: %q %d", errOut, code)
	}
	if _, _, code := run(); code != exitUsage {
		t.Errorf("no args: %d", code)
	}
	if _, _, code := run("bogus"); code != exitUsage {
		t.Errorf("unknown command: %d", code)
	}
}

// A get queued before a put is answered while the put still works: the put's
// hash of an existing 256 MB output must not hold the reply back.
func TestGetReplyDoesNotWaitForPut(t *testing.T) {
	sb := newSandbox(t)
	const size = 256 << 20
	hashStart := time.Now()
	h := sha256.New()
	io.CopyN(h, zeroReader{}, size)
	out := h.Sum(nil)
	hashTime := time.Since(hashStart)

	name := hex.EncodeToString(out)
	os.MkdirAll(filepath.Join(sb.gocache, name[:2]), 0o777)
	f, err := os.Create(filepath.Join(sb.gocache, name[:2], name+"-d"))
	if err != nil {
		t.Fatal(err)
	}
	f.Truncate(size) // sparse zeros, no disk used
	f.Close()

	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	w := protocol.NewWriter(outW)
	w.Hello()
	go func() {
		w.Flush() // before serve, so no stray flush can carry a reply early
		serve(inR, w, store.Open(sb.gocache), nil)
		outW.Close()
	}()
	t.Cleanup(func() { inW.Close(); outR.Close() })
	rd := bufio.NewReader(outR)
	if _, err := rd.ReadString('\n'); err != nil {
		t.Fatal(err)
	}

	b64 := base64.StdEncoding.EncodeToString
	req := fmt.Sprintf(`{"ID":1,"Command":"get","ActionID":%q}`+"\n\n"+
		`{"ID":2,"Command":"put","ActionID":%q,"OutputID":%q,"BodySize":%d}`+"\n\n",
		b64(actionID(1)), b64(actionID(2)), b64(out), size)
	sent := time.Now()
	go inW.Write([]byte(req))
	line, err := rd.ReadString('\n')
	if err != nil || !strings.Contains(line, `"ID":1`) {
		t.Fatalf("first reply %q: %v", line, err)
	}
	if latency := time.Since(sent); latency > hashTime/2 {
		t.Fatalf("get reply took %v while the put's hash takes %v", latency, hashTime)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }
