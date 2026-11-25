//go:build !windows

package backup

import (
	"fmt"
	"io/fs"
	"os/user"
	"strconv"
	"strings"
	"syscall"
)

// dataDirOwner returns the uid and gid the restored tree should keep so a
// server running as an unprivileged user can still read its data after a
// restore done by root.
func dataDirOwner(info fs.FileInfo) (int, int) {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return int(stat.Uid), int(stat.Gid)
	}
	return 0, 0
}

// lookupOwner parses "user" or "user:group" for restore on a fresh machine.
func lookupOwner(value string) (int, int, error) {
	parts := strings.SplitN(value, ":", 2)
	account, err := user.Lookup(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("restore: unknown user %q: %w", parts[0], err)
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return 0, 0, fmt.Errorf("restore: user %q has a non-numeric uid: %w", parts[0], err)
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return 0, 0, fmt.Errorf("restore: user %q has a non-numeric gid: %w", parts[0], err)
	}
	if len(parts) == 2 {
		group, err := user.LookupGroup(parts[1])
		if err != nil {
			return 0, 0, fmt.Errorf("restore: unknown group %q: %w", parts[1], err)
		}
		gid, err = strconv.Atoi(group.Gid)
		if err != nil {
			return 0, 0, fmt.Errorf("restore: group %q has a non-numeric gid: %w", parts[1], err)
		}
	}
	return uid, gid, nil
}
