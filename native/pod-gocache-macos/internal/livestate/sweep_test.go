package livestate

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
)

// deadPID is the pid of a process that has exited.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("/usr/bin/true")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

// Gate fix 8: temp files of dead daemons go, a live daemon's stay.
func TestCleanTemps(t *testing.T) {
	dir := t.TempDir()
	dead, me := strconv.Itoa(deadPID(t)), strconv.Itoa(os.Getpid())
	for _, n := range []string{".index." + dead + ".3", ".clients." + dead, ".index." + me + ".1", ".clients." + me, IndexName, ".index.x.1"} {
		os.WriteFile(filepath.Join(dir, n), nil, 0o600)
	}
	removed := CleanTemps(dir)
	if len(removed) != 2 {
		t.Errorf("removed %v, want the two files of the dead pid", removed)
	}
	for _, n := range []string{".index." + me + ".1", ".clients." + me, IndexName, ".index.x.1"} {
		if _, err := os.Lstat(filepath.Join(dir, n)); err != nil {
			t.Errorf("%s removed", n)
		}
	}
}

// staleDir makes a live directory under root for a cache directory that
// existed and was deleted, with a clients file and a publisher lock.
func staleDir(t *testing.T, root string) string {
	t.Helper()
	cache := t.TempDir()
	id, ok := StatCache(cache)
	if !ok {
		t.Fatal("stat")
	}
	os.Remove(cache)
	dir := Dir(root, id)
	os.MkdirAll(dir, 0o700)
	c, err := OpenClients(dir, id, BootID())
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	os.WriteFile(filepath.Join(dir, PublisherLockName), nil, 0o600)
	return dir
}

// Gate fix 8: a live directory goes only when its cache is gone, no daemon
// holds its publisher lock and no client holds a slot.
func TestSweepStale(t *testing.T) {
	root := t.TempDir()
	gone := staleDir(t, root)
	locked := staleDir(t, root)
	held := staleDir(t, root)
	alive := t.TempDir()
	id, _ := StatCache(alive)
	kept := Dir(root, id)
	os.MkdirAll(kept, 0o700)
	keep := filepath.Join(root, "v1-1-2") // the caller's own directory
	os.MkdirAll(keep, 0o700)

	fd, err := syscall.Open(filepath.Join(locked, PublisherLockName), syscall.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := syscall.Flock(fd, syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "LIVESTATE_HELPER=claim:"+held)
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	if line, err := bufio.NewReader(out).ReadString('\n'); err != nil || line[:4] != "slot" {
		t.Fatalf("helper said %q %v", line, err)
	}

	removed := SweepStale(root, keep)
	if len(removed) != 1 || removed[0] != gone {
		t.Fatalf("removed %v, want only %s", removed, gone)
	}
	for _, d := range []string{locked, held, kept, keep} {
		if _, err := os.Lstat(d); err != nil {
			t.Errorf("%s removed", d)
		}
	}
}
