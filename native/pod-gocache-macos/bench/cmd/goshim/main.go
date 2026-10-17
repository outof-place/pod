// Command goshim is installed as "go" first on PATH for cmd/e2e runs. The machine scheduler
// (claude-acc run -- go ...) recognizes the go command, admits it by memory, then execs this
// shim, so the timing below starts after any queue wait and covers only the go process tree.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

type record struct {
	Args     []string `json:"args"`
	Start    int64    `json:"start"`
	End      int64    `json:"end"`
	WallS    float64  `json:"wall_s"`
	UserS    float64  `json:"user_s"` // go and every descendant it waited for (compile, link, cache prog)
	SysS     float64  `json:"sys_s"`
	MaxRSSMB float64  `json:"max_rss_mb"` // largest single descendant
	Exit     int      `json:"exit"`
	Signal   string   `json:"signal,omitempty"`
}

func main() {
	real := os.Getenv("PODGC_REAL_GO")
	if real == "" {
		real = "/opt/homebrew/bin/go"
	}
	cmd := exec.Command(real, os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	start := time.Now()
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "goshim:", err)
		os.Exit(127)
	}
	go func() {
		for s := range sigs {
			cmd.Process.Signal(s)
		}
	}()
	err := cmd.Wait()
	end := time.Now()
	rec := record{Args: os.Args[1:], Start: start.UnixNano(), End: end.UnixNano(), WallS: end.Sub(start).Seconds()}
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_CHILDREN, &ru)
	rec.UserS = float64(ru.Utime.Sec) + float64(ru.Utime.Usec)/1e6
	rec.SysS = float64(ru.Stime.Sec) + float64(ru.Stime.Usec)/1e6
	rec.MaxRSSMB = float64(ru.Maxrss) / (1 << 20)
	if st, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
		rec.Exit = st.ExitStatus()
		if st.Signaled() {
			rec.Signal = st.Signal().String()
		}
	}
	if err != nil && rec.Exit == 0 {
		rec.Exit = 1
	}
	if path := os.Getenv("PODGC_TIMING"); path != "" {
		if f, ferr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644); ferr == nil {
			b, _ := json.Marshal(rec)
			f.Write(append(b, '\n'))
			f.Close()
		}
	}
	os.Exit(rec.Exit)
}
