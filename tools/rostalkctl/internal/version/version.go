// Package version reports the build identity of the rostalkctl binary.
//
// The values are overridden at build time with -ldflags "-X ...Version=...",
// the same way the server does it.
package version

import (
	"fmt"
	"runtime"
)

var (
	// Version is the semantic version of the build, "dev" for a local build.
	Version = "dev"
	// Commit is the git revision the binary was built from.
	Commit = "unknown"
	// Date is the UTC build timestamp in RFC 3339 form.
	Date = "unknown"
)

// String returns a single-line build description used by `rostalkctl version`
// and by the "user agent" the CLI reports to a server.
func String() string {
	return fmt.Sprintf("%s (commit %s, built %s, %s)", Version, Commit, Date, runtime.Version())
}
