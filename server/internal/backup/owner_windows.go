//go:build windows

package backup

import (
	"errors"
	"io/fs"
)

// dataDirOwner is a no-op on Windows: the server runs only on Linux, and the
// backup package is compiled and tested on the development host as well.
func dataDirOwner(fs.FileInfo) (int, int) { return 0, 0 }

// lookupOwner has no meaning on Windows; restore is a Linux operation.
func lookupOwner(string) (int, int, error) {
	return 0, 0, errors.New("restore: --owner is only supported on Linux")
}
