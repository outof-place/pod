package calc

import (
	"sync"
	"testing"
)

func TestAdd(t *testing.T) {
	if Add(2, 3) != 5 {
		t.Fatal("2+3")
	}
}

func TestDiv(t *testing.T) {
	if _, err := Div(1, 0); err != ErrDivZero {
		t.Fatalf("err = %v", err)
	}
	if q, _ := Div(9, 3); q != 3 {
		t.Fatalf("q = %d", q)
	}
}

// Exercises goroutines under -race without a race.
func TestConcurrentAdd(t *testing.T) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	sum := 0
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			mu.Lock()
			sum = Add(sum, i)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if sum != 28 {
		t.Fatalf("sum = %d", sum)
	}
}
