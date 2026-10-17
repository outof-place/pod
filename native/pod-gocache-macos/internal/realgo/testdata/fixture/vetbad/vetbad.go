// Package vetbad builds but has a vet finding.
package vetbad

import "fmt"

// Describe has a Printf verb mismatch that go vet reports.
func Describe(name string) string {
	return fmt.Sprintf("%d items", name)
}
