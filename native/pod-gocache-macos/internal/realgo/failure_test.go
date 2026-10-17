package realgo

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/trace"
)

// readOnlyBuckets makes every bucket unwritable, as go itself has created them.
func readOnlyBuckets(t *testing.T, gocache string) {
	t.Helper()
	for i := range 256 {
		b := filepath.Join(gocache, fmt.Sprintf("%02x", i))
		os.MkdirAll(b, 0o777)
		os.Chmod(b, 0o555)
	}
	t.Cleanup(func() {
		for i := range 256 {
			os.Chmod(filepath.Join(gocache, fmt.Sprintf("%02x", i)), 0o777)
		}
	})
}

// TestUnwritableStore: when the store refuses writes, go sees the same put
// errors from the client as from the built-in cache, and prints the same.
func TestUnwritableStore(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	cmds := [][]string{
		{"build", "./..."},
		{"test", "./greet"},
		{"list", "-export", "-f", "{{.Export}}", "./greet"},
		{"vet", "./calc"},
	}
	got := map[bool][]outcome{}
	for _, prog := range []bool{false, true} {
		ce := newCache(t, prog)
		readOnlyBuckets(t, ce.gocache)
		for _, args := range cmds {
			r := runGo(t, ws, ce, args...)
			got[prog] = append(got[prog], outcome{code: r.code, stdout: normalize(r.stdout, ws, ce), stderr: normalize(r.stderr, ws, ce)})
		}
		if e, o := checkStore(t, ce.gocache); e+o != 0 {
			t.Errorf("%s wrote %d entries and %d outputs into read-only buckets", ce.mode(), e, o)
		}
	}
	for i, args := range cmds {
		b, c := got[false][i], got[true][i]
		if b.code != c.code || b.stdout != c.stdout || b.stderr != c.stderr {
			t.Errorf("go %v differs\n=== builtin\n%s\n=== client\n%s", args, b, c)
			continue
		}
		t.Logf("go %v: identical (exit %d) %s", args, b.code, strings.ReplaceAll(tail(b.stderr, 2), "\n", " | "))
	}
}

// smallVolume mounts a fresh HFS+ disk image and returns its mount point.
func smallVolume(t *testing.T, mb int) string {
	t.Helper()
	dir := canonical(t, t.TempDir())
	img, mnt := filepath.Join(dir, "vol.dmg"), filepath.Join(dir, "mnt")
	os.Mkdir(mnt, 0o755)
	if out, err := exec.Command("hdiutil", "create", "-size", strconv.Itoa(mb)+"m", "-fs", "HFS+", "-volname", "pgcfull", "-type", "UDIF", img).CombinedOutput(); err != nil {
		t.Fatalf("hdiutil create: %v\n%s", err, out)
	}
	if out, err := exec.Command("hdiutil", "attach", "-nobrowse", "-noverify", "-mountpoint", mnt, img).CombinedOutput(); err != nil {
		t.Fatalf("hdiutil attach: %v\n%s", err, out)
	}
	t.Cleanup(func() { exec.Command("hdiutil", "detach", mnt, "-force").Run() })
	return mnt
}

// fill leaves about free bytes on the volume holding dir.
func fill(t *testing.T, dir string, free int64) string {
	t.Helper()
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		t.Fatal(err)
	}
	avail := int64(st.Bavail) * int64(st.Bsize)
	filler := filepath.Join(dir, "filler")
	f, err := os.Create(filler)
	if err != nil {
		t.Fatal(err)
	}
	chunk := make([]byte, 1<<20)
	for left := avail - free; left > 0; left -= int64(len(chunk)) {
		if _, err := f.Write(chunk[:min(int64(len(chunk)), left)]); err != nil {
			break
		}
	}
	f.Close()
	return filler
}

// TestDiskFull: GOCACHE on a nearly full volume. Puts fail mid-stream; the
// client answers them with errors, never leaves a partial or orphaned file,
// never breaks the protocol, and works again once space returns.
func TestDiskFull(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	for _, prog := range []bool{false, true} {
		vol := smallVolume(t, 48)
		ce := newCache(t, prog)
		ce.gocache = filepath.Join(vol, "gocache")
		os.MkdirAll(ce.gocache, 0o777)
		// Let go create the buckets, then fill the disk.
		if r := runGo(t, ws, ce, "list", "-f", "{{.Name}}", "./greet"); r.code != 0 {
			t.Fatalf("%s: setup list failed: %s", ce.mode(), r.stderr)
		}
		filler := fill(t, vol, 1<<20)
		r := runGo(t, ws, ce, "build", "./...")
		t.Logf("%s on a full disk: exit %d %s", ce.mode(), r.code, strings.ReplaceAll(tail(r.stderr, 3), "\n", " | "))
		if prog {
			if strings.Contains(r.stderr, "GOCACHEPROG") {
				t.Errorf("client broke the protocol on a full disk:\n%s", r.stderr)
			}
			if r.code != 0 && !strings.Contains(r.stderr, "no space left on device") {
				t.Errorf("client failure is not the disk's: %s", r.stderr)
			}
			checkStore(t, ce.gocache)
			ops := traceCounts(t, ce.trace)
			t.Logf("client trace on a full disk: %v", ops)
			if ops[trace.OpPutFailed] == 0 {
				t.Errorf("no put failed: the disk was not full enough to test anything")
			}
		}
		var storedBefore int
		if prog {
			storedBefore = traceCounts(t, ce.trace)[trace.OpPutStored]
		}
		os.Remove(filler)
		r = runGo(t, ws, ce, "build", "./...")
		if r.code != 0 {
			t.Errorf("%s after space returned: exit %d\n%s", ce.mode(), r.code, r.stderr)
		}
		if prog {
			checkStore(t, ce.gocache)
			// Recovery means the client really stores again, not just that go exits 0.
			if stored := traceCounts(t, ce.trace)[trace.OpPutStored]; stored <= storedBefore {
				t.Errorf("recovery session stored nothing: %d stored before, %d after", storedBefore, stored)
			}
			if w := runGo(t, ws, ce, "build", "-x", "./..."); w.code != 0 || compileRE.MatchString(w.stderr) {
				t.Errorf("build after recovery is not fully cached (exit %d):\n%s", w.code, joinMatches(w.stderr))
			}
			r = runGo(t, ws, ce, "test", "./greet", "./calc")
			if r.code != 0 {
				t.Errorf("client test after recovery: %s", r.stdout+r.stderr)
			}
		}
	}
}

// clientPIDs lists running client processes of this test binary's build.
func clientPIDs() []int {
	out, _ := exec.Command("pgrep", "-f", clientBin+" prog").Output()
	var pids []int
	for _, f := range strings.Fields(string(out)) {
		if n, err := strconv.Atoi(f); err == nil {
			pids = append(pids, n)
		}
	}
	return pids
}

func countOutputs(dir string) int {
	n := 0
	buckets, _ := os.ReadDir(dir)
	for _, b := range buckets {
		files, _ := os.ReadDir(filepath.Join(dir, b.Name()))
		for _, f := range files {
			if strings.HasSuffix(f.Name(), "-d") {
				n++
			}
		}
	}
	return n
}

// startColdBuild starts a client-mode cold build and returns once it has
// stored some outputs.
func startColdBuild(t *testing.T, ws workspace, ce cacheEnv) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("go", "build", "-a", "./...")
	cmd.Dir = ws.src
	cmd.Env = goEnv(ce)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(60 * time.Second)
	for countOutputs(ce.gocache) < 20 {
		if time.Now().After(deadline) {
			cmd.Process.Kill()
			t.Fatal("build stored nothing")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cmd
}

// TestGoKilledMidBuild: go dies (SIGKILL) while the client serves it. The
// client exits on its own, silently, and leaves the store consistent.
func TestGoKilledMidBuild(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	ce := newCache(t, true)
	cmd := startColdBuild(t, ws, ce)
	cmd.Process.Kill()
	cmd.Wait()
	deadline := time.Now().Add(5 * time.Second)
	for len(clientPIDs()) > 0 {
		if time.Now().After(deadline) {
			t.Fatalf("client still running after go died: %v", clientPIDs())
		}
		time.Sleep(20 * time.Millisecond)
	}
	checkStore(t, ce.gocache)
	if r := runGo(t, ws, ce, "build", "./..."); r.code != 0 {
		t.Fatalf("build after the kill: %s", r.stderr)
	}
	if ops := traceCounts(t, ce.trace); ops[trace.OpStart] < 2 || ops[trace.OpEOF] < 1 {
		t.Errorf("trace: %v", ops)
	}
}

// TestClientKilledMidBuild: the client dies (SIGKILL). go fails, as it must
// (prog.go treats an early exit as fatal), but no partial output becomes
// visible: at most a temp file is left, and the next build works.
func TestClientKilledMidBuild(t *testing.T) {
	requireRealGo(t)
	ws := newWorkspace(t)
	ce := newCache(t, true)
	cmd := startColdBuild(t, ws, ce)
	for _, pid := range clientPIDs() {
		syscall.Kill(pid, syscall.SIGKILL)
	}
	err := cmd.Wait()
	t.Logf("go after the client was killed: %v", err)
	// checkStore reports temp files as errors; here they are allowed.
	temps := 0
	filepath.WalkDir(ce.gocache, func(path string, d os.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(d.Name(), ".pgc-tmp.") {
			temps++
			os.Remove(path)
		}
		return nil
	})
	t.Logf("temp files left by the killed client: %d", temps)
	checkStoreTorn(t, ce.gocache, true)
	if r := runGo(t, ws, ce, "build", "./..."); r.code != 0 {
		t.Fatalf("build after the kill: %s", r.stderr)
	}
	checkStoreTorn(t, ce.gocache, true)
}
