//go:build race

package store

// The race detector adds allocations of its own.
const raceEnabled = true
