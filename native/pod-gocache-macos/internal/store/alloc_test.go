package store

import "testing"

// A hit allocates nothing in this package; the two allocations left are the
// standard library copying the -a and -d paths into C strings for open(2)
// and stat(2).
func TestGetAllocations(t *testing.T) {
	if raceEnabled {
		t.Skip("allocation counts differ under -race")
	}
	s, _ := newStore(t)
	id, data := testID(1), []byte("benchmark output")
	put(t, s, id, data)
	var h Hit
	allocs := testing.AllocsPerRun(1000, func() {
		if !s.Get(&id, &h) {
			t.Fatal("miss")
		}
	})
	if allocs > 2 {
		t.Fatalf("%v allocations per hit, want at most 2", allocs)
	}
}

func BenchmarkGetHit(b *testing.B) {
	s := Open(b.TempDir())
	id, data := testID(1), []byte("benchmark output")
	out := sha(data)
	var res PutResult
	if err := s.Put(&id, &out, true, int64(len(data)), body(data), &res); err != nil {
		b.Fatal(err)
	}
	var h Hit
	b.ReportAllocs()
	for b.Loop() {
		if !s.Get(&id, &h) {
			b.Fatal("miss")
		}
	}
}
