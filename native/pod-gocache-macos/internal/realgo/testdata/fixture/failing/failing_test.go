package failing

import "testing"

func TestAnswer(t *testing.T) {
	t.Log("checking the answer")
	if got := Answer(); got != 42 {
		t.Errorf("Answer() = %d, want 42", got)
	}
}
