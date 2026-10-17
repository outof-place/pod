package procscan

import (
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The kinfo_proc offsets, checked against the live table: this process, its
// parent and its name must come out right.
func TestSysctlListsThisProcess(t *testing.T) {
	procs, err := Sysctl{}.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(procs) < 10 {
		t.Fatalf("only %d processes", len(procs))
	}
	want := filepath.Base(os.Args[0])
	if len(want) > maxComm {
		want = want[:maxComm]
	}
	for _, p := range procs {
		if int(p.PID) != os.Getpid() {
			continue
		}
		if int(p.PPID) != os.Getppid() || p.Comm != want {
			t.Errorf("self: ppid %d comm %q, want %d %q", p.PPID, p.Comm, os.Getppid(), want)
		}
		age := time.Since(time.Unix(0, p.Start))
		if age < 0 || age > 10*time.Minute {
			t.Errorf("self started %s ago", age)
		}
		return
	}
	t.Fatalf("pid %d not in the table", os.Getpid())
}

// syscall.Sysctl drops a trailing NUL, so the last record can be a byte short.
func TestParseTableShortLastRecord(t *testing.T) {
	rec := func(pid, ppid int32, comm string, start int64) []byte {
		b := make([]byte, kinfoSize)
		binary.LittleEndian.PutUint64(b[offStartSec:], uint64(start))
		binary.LittleEndian.PutUint32(b[offPID:], uint32(pid))
		binary.LittleEndian.PutUint32(b[offPPID:], uint32(ppid))
		copy(b[offComm:], comm)
		return b
	}
	zombie := rec(12, 1, "link", 1002)
	zombie[offStat] = statZombie
	buf := append(rec(10, 1, "go", 1000), zombie...)
	buf = append(buf, rec(11, 10, "compile", 1001)...)
	buf = buf[:len(buf)-1]
	got := parseTable(buf)
	if len(got) != 2 || got[0].Comm != "go" || got[1].PPID != 10 || got[1].Start != 1001*int64(time.Second) {
		t.Errorf("parsed %+v", got)
	}
}

func TestIsFamily(t *testing.T) {
	yes := []string{"go", "compile", "link", "asm", "cgo", "vet", "golangci-lint", "gopls", "pkg.test", "averylongpkgna.t", "averylongpkgn.te", "averylongpkg.tes"}
	no := []string{"staticcheck", "server", "bash", "gopher", "go-build", "", "averylongpackage", "verylongpackage."}
	for _, c := range yes {
		if !IsFamily(c) {
			t.Errorf("IsFamily(%q) false", c)
		}
	}
	for _, c := range no {
		if IsFamily(c) {
			t.Errorf("IsFamily(%q) true", c)
		}
	}
}

// A 16-byte kernel name read back whole decides exactly: Teams' agent is not
// a cut test binary, a long test binary name is one. A name nobody can read
// back keeps the conservative rule.
func TestFullNamesDecideFamily(t *testing.T) {
	for _, c := range []struct {
		p    Proc
		want bool
	}{
		{Proc{Comm: "com.microsoft.teams2.agent", Full: true}, false},
		{Proc{Comm: "com.microsoft.te"}, true},
		{Proc{Comm: "charter-service.test", Full: true}, true},
		{Proc{Comm: "charter-service."}, false},
		{Proc{Comm: "stripeevent.test", Full: true}, true},
		{Proc{Comm: "averylongpkgn.te", Full: true}, false}, // 16 bytes, but whole
	} {
		if got := c.p.inFamily(); got != c.want {
			t.Errorf("%q full=%v: family %v, want %v", c.p.Comm, c.p.Full, got, c.want)
		}
	}
	now := time.Now().UnixNano()
	goProc := Proc{PID: 10, PPID: 1, Start: now - int64(3*time.Hour), Comm: "go"}
	kid := func(comm string, full bool) Proc { return Proc{PID: 11, PPID: 10, Start: now, Comm: comm, Full: full} }
	if _, age, _ := oldest([]Proc{goProc, kid("averylongservern", false)}, now, 30*time.Minute); age != 3*time.Hour {
		t.Errorf("go with a still cut child counts %s, want its full 3h", age)
	}
	if _, age, _ := oldest([]Proc{goProc, kid("averylongservername", true)}, now, 30*time.Minute); age != 30*time.Minute {
		t.Errorf("go waiting on a known program counts %s, want 30m", age)
	}
}

func TestMain(m *testing.M) {
	if os.Getenv("PROCSCAN_SLEEPER") == "1" {
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// The live table reads back a long executable name the kernel cut (this test
// binary, hard linked under a long name).
func TestSysctlResolvesCutNames(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	name := "pod-gocache-procscan-sleeper.test"
	bin := filepath.Join(t.TempDir(), name)
	if err := os.Link(exe, bin); err != nil {
		t.Skipf("hard link: %v", err)
	}
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(), "PROCSCAN_SLEEPER=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		procs, err := Sysctl{}.List()
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range procs {
			if int(p.PID) == cmd.Process.Pid && p.Comm != "" {
				if p.Comm != name || !p.Full || !p.inFamily() {
					t.Fatalf("got %q full=%v family=%v, want %q read back whole", p.Comm, p.Full, p.inFamily(), name)
				}
				return
			}
		}
	}
	t.Fatal("sleeper not in the table")
}

// D1: a go process waiting on a non-go program, and gopls, count as at most
// 30 minutes old; a go with a compiler or test binary under it counts fully.
func TestOldest(t *testing.T) {
	now := time.Now().UnixNano()
	ago := func(d time.Duration) int64 { return now - int64(d) }
	cap := 30 * time.Minute
	cases := []struct {
		name  string
		procs []Proc
		want  time.Duration
		ok    bool
	}{
		{"none", []Proc{{PID: 1, Comm: "launchd", Start: ago(time.Hour)}}, 0, false},
		{"build", []Proc{{PID: 2, Comm: "go", Start: ago(time.Hour)}, {PID: 3, PPID: 2, Comm: "compile", Start: ago(time.Minute)}}, time.Hour, true},
		{"go-run", []Proc{{PID: 2, Comm: "go", Start: ago(72 * time.Hour)}, {PID: 3, PPID: 2, Comm: "server", Start: ago(72 * time.Hour)}}, cap, true},
		{"go-test", []Proc{{PID: 2, Comm: "go", Start: ago(48 * time.Hour)}, {PID: 3, PPID: 2, Comm: "pkg.test", Start: ago(48 * time.Hour)}}, 48 * time.Hour, true},
		{"cut-name-child", []Proc{{PID: 2, Comm: "go", Start: ago(5 * time.Hour)}, {PID: 3, PPID: 2, Comm: "averylongpackage", Start: ago(5 * time.Hour)}}, 5 * time.Hour, true},
		{"go-alone", []Proc{{PID: 2, Comm: "go", Start: ago(2 * time.Hour)}}, 2 * time.Hour, true},
		{"gopls-3-days", []Proc{{PID: 4, Comm: "gopls", Start: ago(72 * time.Hour)}}, cap, true},
		{"gopls-young", []Proc{{PID: 4, Comm: "gopls", Start: ago(10 * time.Minute)}}, 10 * time.Minute, true},
		{"future-start", []Proc{{PID: 4, Comm: "go", Start: now + int64(time.Hour)}}, 0, true},
	}
	for _, c := range cases {
		_, age, ok := oldest(c.procs, now, cap)
		if ok != c.ok || age != c.want {
			t.Errorf("%s: age %s ok %v, want %s %v", c.name, age, ok, c.want, c.ok)
		}
	}
}

// S10: a go process keeps counting for Grace after it exits, then drops out;
// a capped go run stays capped.
func TestTrackerExitGrace(t *testing.T) {
	tr := Tracker{Grace: 45 * time.Minute}
	t0 := time.Now().UnixNano()
	at := func(d time.Duration) int64 { return t0 + int64(d) }
	list := []Proc{{PID: 2, Comm: "go", Start: t0}, {PID: 9, Comm: "go", Start: t0}, {PID: 10, PPID: 9, Comm: "server", Start: t0}}
	if _, age, ok := tr.Update(list, at(20*time.Minute), 30*time.Minute); !ok || age != 20*time.Minute {
		t.Fatalf("live: %s %v", age, ok)
	}
	who, age, ok := tr.Update(list[1:], at(25*time.Minute), 30*time.Minute) // the build exits
	if !ok || who.PID != 2 || who.GoneAt == 0 || age != 25*time.Minute {
		t.Errorf("just exited: %+v %s %v", who, age, ok)
	}
	who, age, _ = tr.Update(list[1:], at(69*time.Minute), 30*time.Minute)
	if who.PID != 2 || age != 69*time.Minute {
		t.Errorf("44 minutes after exit: %+v %s", who, age)
	}
	who, age, _ = tr.Update(list[1:], at(71*time.Minute), 30*time.Minute)
	if who.PID != 9 || age != 30*time.Minute {
		t.Errorf("past the grace the go run (capped) is the oldest: %+v %s", who, age)
	}
	who, age, _ = tr.Update(nil, at(200*time.Minute), 30*time.Minute)
	if who.PID != 9 || age != 30*time.Minute || who.GoneAt == 0 {
		t.Errorf("an exited go run stays capped: %+v %s", who, age)
	}
	if _, _, ok := tr.Update(nil, at(250*time.Minute), 30*time.Minute); ok {
		t.Error("nothing should count after every grace")
	}
}
