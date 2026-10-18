package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"pod-gocache-macos/bench/internal/stats"
)

// pod-gocache trace records (internal/trace): 40 bytes, little-endian.
const (
	pgcRecordSize = 40
	pgcGetHit     = 2
	pgcGetMiss    = 3
	pgcPutStored  = 4
	pgcPutExist   = 5
	pgcPutFailed  = 6
	pgcGetFast    = 9
	pgcLive       = 10
)

var (
	timeRE      = regexp.MustCompile(`(?m)^\s*([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys`)
	rssRE       = regexp.MustCompile(`(?m)^\s*(\d+)\s+maximum resident set size`)
	footprintRE = regexp.MustCompile(`(?m)^\s*(\d+)\s+peak memory footprint`)
)

// summarizePgc reads a pod-gocache run: gets and puts from its trace, and the
// client's CPU, RSS and footprint from /usr/bin/time -l in the go log.
func summarizePgc(traceDir, logPath string) *clientStats {
	cs := &clientStats{}
	files, _ := os.ReadDir(traceDir)
	var getUS []float64
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(traceDir, f.Name()))
		if err != nil {
			cs.Errors++
			continue
		}
		for ; len(data) >= pgcRecordSize; data = data[pgcRecordSize:] {
			if data[39] != 1 {
				continue
			}
			us := float64(binary.LittleEndian.Uint16(data[36:]))
			size := int64(binary.LittleEndian.Uint64(data[24:]))
			switch data[38] {
			case pgcGetHit, pgcGetMiss, pgcGetFast:
				cs.Gets++
				if data[38] != pgcGetMiss {
					cs.Hits++
				}
				if data[38] == pgcGetFast {
					cs.Fast++
				}
				getUS = append(getUS, us)
			case pgcPutStored, pgcPutExist, pgcPutFailed:
				cs.Puts++
				cs.PutBytes += size
				cs.PutSumMS += us / 1e3
			case pgcLive:
				cs.Processes++
			}
		}
	}
	if len(getUS) > 0 {
		s := stats.Summarize(getUS)
		cs.GetP50US, cs.GetMaxUS, cs.GetSumMS = s.Median, s.Max, s.Sum/1e3
		cs.GetP99US = stats.Quantile(getUS, 0.99)
	}
	log, _ := os.ReadFile(logPath)
	for _, m := range timeRE.FindAllSubmatch(log, -1) {
		u, _ := strconv.ParseFloat(string(m[2]), 64)
		s, _ := strconv.ParseFloat(string(m[3]), 64)
		cs.UserS += u
		cs.SysS += s
	}
	for _, m := range rssRE.FindAllSubmatch(log, -1) {
		v, _ := strconv.ParseFloat(string(m[1]), 64)
		cs.RSSMB = max(cs.RSSMB, v/1e6)
	}
	for _, m := range footprintRE.FindAllSubmatch(log, -1) {
		v, _ := strconv.ParseFloat(string(m[1]), 64)
		cs.FootprintMB = max(cs.FootprintMB, v/1e6)
	}
	return cs
}
