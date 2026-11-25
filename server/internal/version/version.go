// Package version reports the build identity of the rostalk-server binary.
//
// The values are overridden at build time with
//
//	-ldflags "-X github.com/v4dikos1/RosTalk/server/internal/version.Version=... \
//	          -X github.com/v4dikos1/RosTalk/server/internal/version.Commit=... \
//	          -X github.com/v4dikos1/RosTalk/server/internal/version.Date=..."
//
// which the Dockerfile and the release pipeline do (deploy/dev/Dockerfile).
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

// String returns a single-line build description used by
// `rostalk-server version`, the startup log and ServerInfo.version.
func String() string {
	return fmt.Sprintf("%s (commit %s, built %s, %s)", Version, Commit, Date, runtime.Version())
}
