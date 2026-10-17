// Package calc does arithmetic.
package calc

import "errors"

// ErrDivZero is returned by Div for a zero divisor.
var ErrDivZero = errors.New("division by zero")

// Add adds.
func Add(a, b int) int { return a + b }

// Div divides.
func Div(a, b int) (int, error) {
	if b == 0 {
		return 0, ErrDivZero
	}
	return a / b, nil
}

// Unused is never tested, so coverage stays below 100%.
func Unused(a int) int {
	if a > 10 {
		return a * 2
	}
	return a
}
