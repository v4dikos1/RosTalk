// Package nickname holds the display-name rules shared by the handshake and
// the SetNickname request, so both paths accept exactly the same names.
package nickname

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// MaxRunes is the maximum display name length. Longer names are truncated
// rather than rejected: a long name is not a security problem and the client
// should not lose the login over it.
const MaxRunes = 64

// ErrEmpty is returned when a name is required but empty.
var ErrEmpty = errors.New("nickname must not be empty")

// ErrControlCharacters is returned when a name contains characters that would
// break the line-oriented logs and the UI.
var ErrControlCharacters = errors.New("nickname contains control characters")

// Normalize trims and validates a display name. When raw is empty, fallback is
// used if it is not empty (a returning user keeps their previous name);
// otherwise the name is required.
func Normalize(raw, fallback string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		if fallback != "" {
			return fallback, nil
		}
		return "", ErrEmpty
	}
	if utf8.RuneCountInString(name) > MaxRunes {
		name = string([]rune(name)[:MaxRunes])
	}
	if strings.ContainsAny(name, "\x00\r\n\t") {
		return "", ErrControlCharacters
	}
	return name, nil
}

// Validate is Normalize without a fallback and with a request-friendly error.
func Validate(raw string) (string, error) {
	name, err := Normalize(raw, "")
	if err != nil {
		return "", fmt.Errorf("invalid nickname: %w", err)
	}
	return name, nil
}
