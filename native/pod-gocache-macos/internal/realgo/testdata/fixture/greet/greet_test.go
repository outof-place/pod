package greet

import (
	"bufio"
	"os"
	"testing"
)

// Reads a file and an env var so the test cache records inputs.
func TestHelloNames(t *testing.T) {
	f, err := os.Open("testdata/names.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		if got := Hello(s.Text()); got != "hello, "+s.Text() {
			t.Errorf("Hello(%q) = %q", s.Text(), got)
		}
	}
	if os.Getenv("FIXTURE_GREETING") == "fail" {
		t.Fatal("FIXTURE_GREETING=fail")
	}
}

func TestHelloEmpty(t *testing.T) {
	if got := Hello(""); got != "hello, world" {
		t.Fatalf("got %q", got)
	}
}
