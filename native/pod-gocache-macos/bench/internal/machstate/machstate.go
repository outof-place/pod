// Package machstate records how loaded the Mac is around a measurement.
package machstate

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Snapshot struct {
	Time          time.Time
	SwapUsedMB    float64
	SwapTotalMB   float64
	FreePercent   int // memory_pressure -Q "System-wide memory free percentage"
	PressureLevel int // kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical
	Load1         float64
	Load5         float64
	Load15        float64
}

var (
	swapRe = regexp.MustCompile(`total = ([0-9.]+)M\s+used = ([0-9.]+)M`)
	loadRe = regexp.MustCompile(`\{ ([0-9.]+) ([0-9.]+) ([0-9.]+) \}`)
	freeRe = regexp.MustCompile(`free percentage: ([0-9]+)%`)
)

// Take costs a few tens of milliseconds (two short execs); call it between runs, never inside one.
func Take() Snapshot {
	s := Snapshot{Time: time.Now(), FreePercent: -1, PressureLevel: -1}
	if out, err := exec.Command("/usr/sbin/sysctl", "-n", "vm.swapusage", "vm.loadavg").Output(); err == nil {
		if m := swapRe.FindStringSubmatch(string(out)); m != nil {
			s.SwapTotalMB, _ = strconv.ParseFloat(m[1], 64)
			s.SwapUsedMB, _ = strconv.ParseFloat(m[2], 64)
		}
		if m := loadRe.FindStringSubmatch(string(out)); m != nil {
			s.Load1, _ = strconv.ParseFloat(m[1], 64)
			s.Load5, _ = strconv.ParseFloat(m[2], 64)
			s.Load15, _ = strconv.ParseFloat(m[3], 64)
		}
	}
	if out, err := exec.Command("/usr/bin/memory_pressure", "-Q").Output(); err == nil {
		if m := freeRe.FindStringSubmatch(string(out)); m != nil {
			s.FreePercent, _ = strconv.Atoi(m[1])
		}
	}
	if v, err := syscall.SysctlUint32("kern.memorystatus_vm_pressure_level"); err == nil {
		s.PressureLevel = int(v)
	}
	return s
}

func (s Snapshot) String() string {
	return fmt.Sprintf("swap %.1f/%.1f GB, free %d%%, pressure level %d, load %.1f %.1f %.1f",
		s.SwapUsedMB/1024, s.SwapTotalMB/1024, s.FreePercent, s.PressureLevel, s.Load1, s.Load5, s.Load15)
}

// Header is a one-line description of the machine for result files.
func Header() string {
	brand, _ := syscall.Sysctl("machdep.cpu.brand_string")
	ncpu, _ := syscall.SysctlUint32("hw.ncpu")
	p, _ := syscall.SysctlUint32("hw.perflevel0.physicalcpu")
	e, _ := syscall.SysctlUint32("hw.perflevel1.physicalcpu")
	ver, _ := exec.Command("/usr/bin/sw_vers", "-productVersion").Output()
	return fmt.Sprintf("%s, %d cores (%dP+%dE), macOS %s", brand, ncpu, p, e, strings.TrimSpace(string(ver)))
}
