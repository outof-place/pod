// Package proglog is the JSONL request log written by cmd/passprog and read by the harnesses:
// one Event per request, then one Summary line per client process.
package proglog

import (
	"bufio"
	"encoding/json"
	"os"
)

// Event times are Unix nanoseconds so they line up with the harness and other processes.
type Event struct {
	ID        int64  `json:"id"`
	Cmd       string `json:"cmd"`
	Recv      int64  `json:"recv"` // request line parsed
	Done      int64  `json:"done"` // response written
	Hit       bool   `json:"hit,omitempty"`
	Action    string `json:"action,omitempty"`
	Output    string `json:"output,omitempty"`
	Size      int64  `json:"size,omitempty"`
	BodyStart int64  `json:"body_start,omitempty"` // opening quote seen
	BodyEnd   int64  `json:"body_end,omitempty"`   // the read that delivered the closing quote returned
	Decoded   int64  `json:"decoded,omitempty"`    // body decoded, written and file closed
	Dedupe    bool   `json:"dedupe,omitempty"`
	Reads     int    `json:"reads,omitempty"`
	Err       string `json:"err,omitempty"`
}

type Summary struct {
	Summary  bool    `json:"summary"`
	Nonce    string  `json:"nonce"`
	Main     int64   `json:"main"`  // main() entered
	Ready    int64   `json:"ready"` // capabilities line written
	Exit     int64   `json:"exit"`
	UserS    float64 `json:"user_s"`
	SysS     float64 `json:"sys_s"`
	MaxRSSMB float64 `json:"max_rss_mb"`
	Decoder  string  `json:"decoder"`
	Write    string  `json:"write"`
	Put      string  `json:"put"`
}

// Process is everything one client process logged.
type Process struct {
	Events  []Event
	Summary Summary
}

// Read returns the processes in a log, in the order they exited.
func Read(path string) ([]Process, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []Process
	var cur []Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var probe struct {
			Summary bool `json:"summary"`
		}
		if err := json.Unmarshal(sc.Bytes(), &probe); err != nil {
			return nil, err
		}
		if probe.Summary {
			var s Summary
			json.Unmarshal(sc.Bytes(), &s)
			out = append(out, Process{Events: cur, Summary: s})
			cur = nil
			continue
		}
		var e Event
		json.Unmarshal(sc.Bytes(), &e)
		cur = append(cur, e)
	}
	return out, sc.Err()
}
