// Package stats summarizes repeated measurements as median and spread.
package stats

import (
	"fmt"
	"math"
	"slices"
)

type Summary struct {
	N                          int
	Median, Min, Max, P25, P75 float64
	Mean, Sum                  float64
}

// quantile interpolates linearly between order statistics (type 7, as in R and NumPy).
func quantile(sorted []float64, q float64) float64 {
	if len(sorted) == 0 {
		return math.NaN()
	}
	pos := q * float64(len(sorted)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	return sorted[lo] + (sorted[hi]-sorted[lo])*(pos-float64(lo))
}

func Summarize(xs []float64) Summary {
	s := slices.Clone(xs)
	slices.Sort(s)
	out := Summary{N: len(s)}
	if len(s) == 0 {
		return out
	}
	for _, x := range s {
		out.Sum += x
	}
	out.Mean = out.Sum / float64(len(s))
	out.Min, out.Max = s[0], s[len(s)-1]
	out.Median = quantile(s, 0.5)
	out.P25 = quantile(s, 0.25)
	out.P75 = quantile(s, 0.75)
	return out
}

// Quantile returns the q-quantile of xs.
func Quantile(xs []float64, q float64) float64 {
	s := slices.Clone(xs)
	slices.Sort(s)
	return quantile(s, q)
}

// Format prints "median [min..max] IQR p25..p75" with the given verb, e.g. "%.2f".
func (s Summary) Format(verb string) string {
	f := func(x float64) string { return fmt.Sprintf(verb, x) }
	return fmt.Sprintf("%s [%s..%s] IQR %s..%s", f(s.Median), f(s.Min), f(s.Max), f(s.P25), f(s.P75))
}
