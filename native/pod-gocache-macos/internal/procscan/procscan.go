// Package procscan finds the oldest go-family process (alive, or exited
// within a grace), so the eviction window covers everything a build, or a
// tool reading its export data, may still read. It reads the
// kernel process table with sysctl kern.proc.all (no cgo).
package procscan

import (
	"encoding/binary"
	"strings"
	"sync"
	"syscall"
	"time"
	_ "unsafe" // go:linkname
)

// Proc is one process table entry. Start is wall unix nanoseconds.
type Proc struct {
	PID, PPID int32
	Start     int64
	Comm      string // executable name; the kernel cuts it to 16 bytes
	Full      bool   // Comm is the whole name, read back with KERN_PROCARGS2
}

// Lister reads the process table.
type Lister interface {
	List() ([]Proc, error)
}

// Sysctl reads the live table.
type Sysctl struct{}

// kinfo_proc layout on darwin arm64 and amd64 (golang.org/x/sys/unix
// ztypes_darwin_*.go v0.48.0, checked against a live table in the tests).
const (
	kinfoSize   = 648
	offStartSec = 0
	offStartUs  = 8
	offStat     = 36
	offPID      = 40
	offComm     = 243
	commLen     = 17
	offPPID     = 560
	statZombie  = 5 // SZOMB
)

func (Sysctl) List() ([]Proc, error) {
	var raw string
	var err error
	// The table can grow between sysctl's size query and the read.
	for range 4 {
		raw, err = syscall.Sysctl("kern.proc.all")
		if err != syscall.ENOMEM {
			break
		}
	}
	if err != nil {
		return nil, err
	}
	procs := parseTable([]byte(raw))
	resolveCut(procs)
	return procs, nil
}

// syscall.sysctl is pushed for x/net ("do not change the type signature").
//
//go:linkname sysctl syscall.sysctl
func sysctl(mib []int32, old *byte, oldlen *uintptr, new *byte, newlen uintptr) error

const (
	ctlKern       = 1
	kernProcargs2 = 49
)

// cutNames caches the whole names of processes whose kernel name is 16
// bytes long; an executable never changes for one (pid, start).
var cutNames = struct {
	sync.Mutex
	m map[procKey]string
}{m: map[procKey]string{}}

// resolveCut replaces a 16-byte kernel name with the executable's whole
// name when this user can read it: com.microsoft.teams2 must not pass for a
// cut test binary, and charter-service.test must not pass for something else.
func resolveCut(procs []Proc) {
	cutNames.Lock()
	defer cutNames.Unlock()
	live := map[procKey]bool{}
	var buf []byte
	for i := range procs {
		p := &procs[i]
		if len(p.Comm) != maxComm {
			continue
		}
		k := procKey{p.PID, p.Start}
		live[k] = true
		full, ok := cutNames.m[k]
		if !ok {
			if buf == nil {
				// The kernel wants room for all of argv and env: kern.argmax.
				n, err := syscall.SysctlUint32("kern.argmax")
				if err != nil || n == 0 {
					n = 1 << 20
				}
				buf = make([]byte, n)
			}
			full = execName(p.PID, buf)
			cutNames.m[k] = full
		}
		if len(full) >= maxComm && strings.HasPrefix(full, p.Comm) {
			p.Comm, p.Full = full, true
		}
	}
	for k := range cutNames.m {
		if !live[k] {
			delete(cutNames.m, k)
		}
	}
}

// execName reads the base name of pid's executable path from
// KERN_PROCARGS2 (an int32 argc, then the path); "" when unreadable.
func execName(pid int32, buf []byte) string {
	n := uintptr(len(buf))
	if sysctl([]int32{ctlKern, kernProcargs2, pid}, &buf[0], &n, nil, 0) != nil || n <= 4 || n > uintptr(len(buf)) {
		return ""
	}
	path := buf[4:n]
	if i := strings.IndexByte(string(path), 0); i >= 0 {
		path = path[:i]
	}
	name := string(path)
	return name[strings.LastIndexByte(name, '/')+1:]
}

// parseTable decodes kinfo_proc records. syscall.Sysctl drops a trailing NUL
// byte, so the last record may be one byte short.
func parseTable(b []byte) []Proc {
	if r := len(b) % kinfoSize; r != 0 {
		b = append(b, make([]byte, kinfoSize-r)...)
	}
	le := binary.LittleEndian
	procs := make([]Proc, 0, len(b)/kinfoSize)
	for off := 0; off+kinfoSize <= len(b); off += kinfoSize {
		k := b[off : off+kinfoSize]
		if k[offStat] == statZombie {
			continue
		}
		comm := k[offComm : offComm+commLen]
		if i := strings.IndexByte(string(comm), 0); i >= 0 {
			comm = comm[:i]
		}
		sec := int64(le.Uint64(k[offStartSec:]))
		us := int64(int32(le.Uint32(k[offStartUs:])))
		procs = append(procs, Proc{
			PID:   int32(le.Uint32(k[offPID:])),
			PPID:  int32(le.Uint32(k[offPPID:])),
			Start: sec*int64(time.Second) + us*int64(time.Microsecond),
			Comm:  string(comm),
		})
	}
	return procs
}

// maxComm is MAXCOMLEN: a name this long may have been cut.
const maxComm = 16

var familyNames = map[string]bool{
	"go": true, "compile": true, "link": true, "asm": true, "cgo": true, "vet": true,
	"golangci-lint": true, "gopls": true,
}

// IsFamily reports whether a process name is a go tool or a test binary that
// reads build cache files.
func IsFamily(comm string) bool {
	if familyNames[comm] || strings.HasSuffix(comm, ".test") {
		return true
	}
	// "verylongpkgname.test" is cut to 16 bytes; keep the ones whose cut
	// still shows a ".t" prefix of the suffix.
	if len(comm) == maxComm {
		for _, s := range []string{".tes", ".te", ".t"} {
			if strings.HasSuffix(comm, s) {
				return true
			}
		}
	}
	return false
}

// inFamily is IsFamily, exact for a name read back whole.
func (p Proc) inFamily() bool {
	if p.Full {
		return familyNames[p.Comm] || strings.HasSuffix(p.Comm, ".test")
	}
	return IsFamily(p.Comm)
}

// childLooksLikeTool is the conservative test for a go process's child: a
// still cut name could be a test binary, and the GOCACHEPROG helper is part
// of go.
func childLooksLikeTool(p Proc) bool {
	return p.inFamily() || (!p.Full && len(p.Comm) >= maxComm) || p.Comm == "pod-gocache"
}

// oldest returns the oldest go-family process. gopls, and a go process whose
// children are all non-go programs (a go run or go tool waiting on its
// program), count as at most goRunCap old (now is wall unix ns). ok is false
// when no family process runs.
func oldest(procs []Proc, now int64, goRunCap time.Duration) (who Proc, age time.Duration, ok bool) {
	for _, m := range family(procs) {
		if a := m.age(now, goRunCap); !ok || a > age {
			who, age, ok = m.Proc, a, true
		}
	}
	return who, age, ok
}

// Member is a go-family process; Capped marks one that counts as at most
// goRunCap old: gopls, or a go run waiting on its program.
type Member struct {
	Proc
	Capped bool
	GoneAt int64 // wall ns it was last missing from the table; 0 while alive
}

func (m Member) age(now int64, goRunCap time.Duration) time.Duration {
	a := max(0, time.Duration(now-m.Start))
	if m.Capped {
		a = min(a, goRunCap)
	}
	return a
}

func family(procs []Proc) []Member {
	children := map[int32][]Proc{}
	for _, p := range procs {
		children[p.PPID] = append(children[p.PPID], p)
	}
	var out []Member
	for _, p := range procs {
		if p.inFamily() {
			// gopls lives as long as the editor; the go list it runs counts on its own.
			capped := p.Comm == "gopls" || (p.Comm == "go" && waitsOnProgram(children[p.PID]))
			out = append(out, Member{Proc: p, Capped: capped})
		}
	}
	return out
}

// Tracker keeps go-family processes counting for Grace after they exit: a
// tool that ran go list -export reads the export data after go list is gone,
// and only the window protects those files then.
type Tracker struct {
	Grace time.Duration
	live  map[procKey]Member
	gone  map[procKey]Member
}

type procKey struct {
	pid   int32
	start int64
}

// Update takes a fresh table and returns the oldest process that is alive or
// exited within Grace, with its age as in oldest.
func (t *Tracker) Update(procs []Proc, now int64, goRunCap time.Duration) (who Member, age time.Duration, ok bool) {
	if t.gone == nil {
		t.gone = map[procKey]Member{}
	}
	live := map[procKey]Member{}
	for _, m := range family(procs) {
		live[procKey{m.PID, m.Start}] = m
	}
	for k, m := range t.live {
		if _, still := live[k]; !still {
			m.GoneAt = now
			t.gone[k] = m
		}
	}
	t.live = live
	for k, m := range t.gone {
		if time.Duration(now-m.GoneAt) > t.Grace {
			delete(t.gone, k)
		}
	}
	for _, set := range []map[procKey]Member{live, t.gone} {
		for _, m := range set {
			if a := m.age(now, goRunCap); !ok || a > age || (a == age && m.PID < who.PID) {
				who, age, ok = m, a, true
			}
		}
	}
	return who, age, ok
}

func waitsOnProgram(kids []Proc) bool {
	if len(kids) == 0 {
		return false
	}
	for _, k := range kids {
		if childLooksLikeTool(k) {
			return false
		}
	}
	return true
}
