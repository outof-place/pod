// Package greet builds greetings.
package greet

import "strings"

// Hello greets name.
func Hello(name string) string {
	if name == "" {
		name = "world"
	}
	return "hello, " + strings.TrimSpace(name)
}
