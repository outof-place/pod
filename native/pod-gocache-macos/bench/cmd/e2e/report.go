package main

import (
	"fmt"
	"io"
	"slices"

	"pod-gocache-macos/bench/internal/proglog"
	"pod-gocache-macos/bench/internal/stats"
)

type clientStats struct {
	Processes int     `json:"processes"`
	Gets      int     `json:"gets"`
	Hits      int     `json:"hits"`
	Puts      int     `json:"puts"`
	PutBytes  int64   `json:"put_bytes"`
	GetP50US  float64 `json:"get_p50_us"` // request parsed -> response written, inside the client
	GetP99US  float64 `json:"get_p99_us"`
	GetMaxUS  float64 `json:"get_max_us"`
	GetSumMS  float64 `json:"get_sum_ms"`
	PutSumMS  float64 `json:"put_sum_ms"`
	UserS     float64 `json:"user_s"`
	SysS      float64 `json:"sys_s"`
	StartupMS float64 `json:"startup_ms"` // main() -> capabilities written, first process
	Big       *bigPut `json:"big,omitempty"`
	Errors    int     `json:"errors"`
	// pod-gocache modes
	Fast        int     `json:"fast,omitempty"` // hits served from the shared index
	RSSMB       float64 `json:"rss_mb,omitempty"`
	FootprintMB float64 `json:"footprint_mb,omitempty"`
}

// bigPut is the largest put of a run, split at the moments the client can observe.
type bigPut struct {
	Size       int64   `json:"size"`
	Dedupe     bool    `json:"dedupe"`
	Action     string  `json:"action"`
	Output     string  `json:"output"`
	StreamMS   float64 `json:"stream_ms"`   // opening quote -> closing quote: go's encode + pipe
	TailMS     float64 `json:"tail_ms"`     // closing quote -> response written: client work after go is done sending
	HeaderMS   float64 `json:"header_ms"`   // request line -> opening quote
	Reads      int     `json:"reads"`       // read(2) calls for the body
	StreamMBps float64 `json:"stream_mbps"` // decoded MB per second of stream
}

func summarizeClient(path string) *clientStats {
	procs, err := proglog.Read(path)
	if err != nil {
		return &clientStats{Errors: 1}
	}
	cs := &clientStats{Processes: len(procs)}
	var getUS []float64
	for i, p := range procs {
		if i == 0 {
			cs.StartupMS = float64(p.Summary.Ready-p.Summary.Main) / 1e6
		}
		cs.UserS += p.Summary.UserS
		cs.SysS += p.Summary.SysS
		for _, e := range p.Events {
			if e.Err != "" {
				cs.Errors++
			}
			lat := float64(e.Done - e.Recv)
			switch e.Cmd {
			case "get":
				cs.Gets++
				if e.Hit {
					cs.Hits++
				}
				getUS = append(getUS, lat/1e3)
			case "put":
				cs.Puts++
				cs.PutBytes += e.Size
				cs.PutSumMS += lat / 1e6
				if cs.Big == nil || e.Size > cs.Big.Size {
					cs.Big = &bigPut{Size: e.Size, Dedupe: e.Dedupe, Action: e.Action, Output: e.Output, Reads: e.Reads}
					if e.BodyEnd > 0 {
						cs.Big.StreamMS = float64(e.BodyEnd-e.BodyStart) / 1e6
						cs.Big.TailMS = float64(e.Done-e.BodyEnd) / 1e6
						cs.Big.HeaderMS = float64(e.BodyStart-e.Recv) / 1e6
						if cs.Big.StreamMS > 0 {
							cs.Big.StreamMBps = float64(e.Size) / 1e6 / (cs.Big.StreamMS / 1e3)
						}
					}
				}
			}
		}
	}
	if len(getUS) > 0 {
		s := stats.Summarize(getUS)
		cs.GetP50US, cs.GetMaxUS, cs.GetSumMS = s.Median, s.Max, s.Sum/1e3
		cs.GetP99US = stats.Quantile(getUS, 0.99)
	}
	return cs
}

func pick(recs []runRecord, f func(runRecord) float64) []float64 {
	var out []float64
	for _, r := range recs {
		out = append(out, f(r))
	}
	return out
}

func report(w io.Writer, scenario string, modes []string, all []runRecord) {
	byMode := map[string][]runRecord{}
	var failed []runRecord
	for _, r := range all {
		if r.OK {
			byMode[r.Mode] = append(byMode[r.Mode], r)
		} else {
			failed = append(failed, r)
		}
	}
	snap := func(f func(runRecord) float64) stats.Summary { return stats.Summarize(pick(all, f)) }
	fmt.Fprintf(w, "Machine during the measured runs: swap used %.1f..%.1f GB, memory free %.0f..%.0f%%, pressure level %.0f..%.0f, load1 %.1f..%.1f\n\n",
		snap(func(r runRecord) float64 { return r.Before.SwapUsedMB / 1024 }).Min,
		snap(func(r runRecord) float64 { return r.Before.SwapUsedMB / 1024 }).Max,
		snap(func(r runRecord) float64 { return float64(r.Before.FreePercent) }).Min,
		snap(func(r runRecord) float64 { return float64(r.Before.FreePercent) }).Max,
		snap(func(r runRecord) float64 { return float64(r.Before.PressureLevel) }).Min,
		snap(func(r runRecord) float64 { return float64(r.Before.PressureLevel) }).Max,
		snap(func(r runRecord) float64 { return r.Before.Load1 }).Min,
		snap(func(r runRecord) float64 { return r.Before.Load1 }).Max)

	fmt.Fprintf(w, "| mode | n | wall s: median [min..max] IQR | CPU s (user+sys, go tree) | max RSS MB |\n|---|---|---|---|---|\n")
	for _, m := range modes {
		rs := byMode[m]
		fmt.Fprintf(w, "| %s | %d | %s | %s | %.0f |\n", m, len(rs),
			stats.Summarize(pick(rs, func(r runRecord) float64 { return r.Go.WallS })).Format("%.2f"),
			stats.Summarize(pick(rs, func(r runRecord) float64 { return r.Go.UserS + r.Go.SysS })).Format("%.2f"),
			stats.Summarize(pick(rs, func(r runRecord) float64 { return r.Go.MaxRSSMB })).Median)
	}
	base := byMode["builtin"]
	if len(base) > 0 {
		fmt.Fprintf(w, "\nOverhead vs builtin (wall). Ratio of medians, and the paired difference within each round (same load):\n\n| mode | median ratio | paired diff s: median [min..max] | paired diff %%: median [min..max] |\n|---|---|---|---|\n")
		bm := stats.Summarize(pick(base, func(r runRecord) float64 { return r.Go.WallS })).Median
		for _, m := range modes {
			if m == "builtin" || len(byMode[m]) == 0 {
				continue
			}
			var diffs, pct []float64
			for _, r := range byMode[m] {
				for _, b := range base {
					if b.Round == r.Round {
						diffs = append(diffs, r.Go.WallS-b.Go.WallS)
						pct = append(pct, 100*(r.Go.WallS-b.Go.WallS)/b.Go.WallS)
					}
				}
			}
			cm := stats.Summarize(pick(byMode[m], func(r runRecord) float64 { return r.Go.WallS })).Median
			fmt.Fprintf(w, "| %s | %+.2f%% | %s | %s |\n", m, 100*(cm/bm-1),
				stats.Summarize(diffs).Format("%+.2f"), stats.Summarize(pct).Format("%+.1f"))
		}
	}
	if len(all) > 0 && all[0].Phases != nil {
		fmt.Fprintf(w, "\nPhases from -debug-trace (cache lookups happen before the link):\n\n| mode | before link s | link s | after link s | before-link paired diff vs builtin s: median [min..max] |\n|---|---|---|---|---|\n")
		for _, m := range modes {
			rs := slices.DeleteFunc(slices.Clone(byMode[m]), func(r runRecord) bool { return r.Phases == nil })
			var diffs []float64
			for _, r := range rs {
				for _, b := range base {
					if b.Round == r.Round && b.Phases != nil && m != "builtin" {
						diffs = append(diffs, r.Phases.BeforeLinkS-b.Phases.BeforeLinkS)
					}
				}
			}
			ph := func(f func(*phases) float64) string {
				return stats.Summarize(pick(rs, func(r runRecord) float64 { return f(r.Phases) })).Format("%.2f")
			}
			d := "-"
			if len(diffs) > 0 {
				d = stats.Summarize(diffs).Format("%+.2f")
			}
			fmt.Fprintf(w, "| %s | %s | %s | %s | %s |\n", m, ph(func(p *phases) float64 { return p.BeforeLinkS }),
				ph(func(p *phases) float64 { return p.LinkS }), ph(func(p *phases) float64 { return p.AfterLinkS }), d)
		}
	}
	fmt.Fprintf(w, "\nClient-side view (medians over runs):\n\n| mode | gets | hits | fast | puts | put MB | get p50 us | get p99 us | get max us | sum of gets ms | client CPU ms | startup ms | client RSS / footprint MB |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
	for _, m := range modes {
		rs := byMode[m]
		if len(rs) == 0 || rs[0].Client == nil {
			continue
		}
		med := func(f func(*clientStats) float64) float64 {
			return stats.Summarize(pick(rs, func(r runRecord) float64 { return f(r.Client) })).Median
		}
		fmt.Fprintf(w, "| %s | %.0f | %.0f | %.0f | %.0f | %.1f | %.1f | %.1f | %.0f | %.1f | %.1f | %.2f | %.1f / %.1f |\n", m,
			med(func(c *clientStats) float64 { return float64(c.Gets) }),
			med(func(c *clientStats) float64 { return float64(c.Hits) }),
			med(func(c *clientStats) float64 { return float64(c.Fast) }),
			med(func(c *clientStats) float64 { return float64(c.Puts) }),
			med(func(c *clientStats) float64 { return float64(c.PutBytes) / 1e6 }),
			med(func(c *clientStats) float64 { return c.GetP50US }),
			med(func(c *clientStats) float64 { return c.GetP99US }),
			med(func(c *clientStats) float64 { return c.GetMaxUS }),
			med(func(c *clientStats) float64 { return c.GetSumMS }),
			med(func(c *clientStats) float64 { return 1e3 * (c.UserS + c.SysS) }),
			med(func(c *clientStats) float64 { return c.StartupMS }),
			med(func(c *clientStats) float64 { return c.RSSMB }),
			med(func(c *clientStats) float64 { return c.FootprintMB }))
	}
	if scenario == "put" {
		fmt.Fprintf(w, "\nLargest put per run (the handlers archive). stream = go's base64 encode + pipe as the client sees it; tail = client work after go finished sending:\n\n| mode | n | size MB | stream ms | stream MB/s | tail ms | header ms | reads |\n|---|---|---|---|---|---|---|---|\n")
		for _, m := range modes {
			rs := slices.DeleteFunc(slices.Clone(byMode[m]), func(r runRecord) bool { return r.Client == nil || r.Client.Big == nil })
			if len(rs) == 0 {
				continue
			}
			b := func(f func(*bigPut) float64) stats.Summary {
				return stats.Summarize(pick(rs, func(r runRecord) float64 { return f(r.Client.Big) }))
			}
			fmt.Fprintf(w, "| %s | %d | %.1f | %s | %s | %s | %s | %.0f |\n", m, len(rs),
				b(func(p *bigPut) float64 { return float64(p.Size) / 1e6 }).Median,
				b(func(p *bigPut) float64 { return p.StreamMS }).Format("%.0f"),
				b(func(p *bigPut) float64 { return p.StreamMBps }).Format("%.0f"),
				b(func(p *bigPut) float64 { return p.TailMS }).Format("%.1f"),
				b(func(p *bigPut) float64 { return p.HeaderMS }).Format("%.2f"),
				b(func(p *bigPut) float64 { return float64(p.Reads) }).Median)
		}
	}
	for _, r := range failed {
		fmt.Fprintf(w, "\nFAILED run: %s round %d: %s\n", r.Mode, r.Round, r.Note)
	}
}
