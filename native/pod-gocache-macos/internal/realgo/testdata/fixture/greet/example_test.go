package greet_test

import (
	"fmt"

	"example.com/fixture/greet"
)

func ExampleHello() {
	fmt.Println(greet.Hello("pod"))
	// Output: hello, pod
}
