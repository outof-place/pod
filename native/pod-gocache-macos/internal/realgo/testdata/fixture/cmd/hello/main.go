// Command hello prints a greeting and its arguments.
package main

import (
	"fmt"
	"os"

	"example.com/fixture/calc"
	"example.com/fixture/greet"
)

func main() {
	fmt.Println(greet.Hello("pod"), calc.Add(40, 2), os.Args[1:])
}
