package main

import (
	"encoding/json"
	"os"
	"strings"
)

// phases splits a go run at its link action, from a -debug-trace file (Chrome trace, ts in Unix µs).
// Cache lookups happen before the link; the link itself does not talk to the cache.
type phases struct {
	BeforeLinkS float64 `json:"before_link_s"`
	LinkS       float64 `json:"link_s"`
	AfterLinkS  float64 `json:"after_link_s"`
}

func splitAtLink(path string, g shimRecord) *phases {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var events []struct {
		Name string  `json:"name"`
		Ph   string  `json:"ph"`
		Ts   float64 `json:"ts"`
	}
	if json.NewDecoder(f).Decode(&events) != nil {
		return nil
	}
	var begin, end float64
	for _, e := range events {
		if !strings.HasPrefix(e.Name, "Executing action (link ") {
			continue
		}
		switch e.Ph {
		case "B":
			if begin == 0 || e.Ts < begin {
				begin = e.Ts
			}
		case "E":
			if e.Ts > end {
				end = e.Ts
			}
		}
	}
	if begin == 0 || end == 0 {
		return &phases{BeforeLinkS: g.WallS}
	}
	start, stop := float64(g.Start)/1e3, float64(g.End)/1e3
	return &phases{BeforeLinkS: (begin - start) / 1e6, LinkS: (end - begin) / 1e6, AfterLinkS: (stop - end) / 1e6}
}
