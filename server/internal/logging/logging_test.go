package logging

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteRotatesWithoutLosingTheCurrentLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "logs", "rostalk.log")
	writer, err := New(path, 64, 3)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = writer.Close() }()

	lines := []string{
		"first line, long enough to fill the file\n",
		"second line, rotated away\n",
		"third line stays in the active file\n",
		"fourth line\n",
	}
	for _, line := range lines {
		if _, err := writer.Write([]byte(line)); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	active, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read active file: %v", err)
	}
	if !strings.Contains(string(active), "fourth line") {
		t.Fatalf("active file lost the newest line: %q", active)
	}
	// Every line must still exist somewhere in the chain.
	combined := string(active)
	for index := 1; index <= 3; index++ {
		data, readErr := os.ReadFile(path + "." + itoa(index))
		if readErr != nil {
			if os.IsNotExist(readErr) {
				continue
			}
			t.Fatalf("read rotated %d: %v", index, readErr)
		}
		combined += string(data)
	}
	for _, line := range lines {
		if !strings.Contains(combined, strings.TrimSpace(line)) {
			t.Errorf("line %q was lost in the rotation: %q", strings.TrimSpace(line), combined)
		}
	}
	// The rotation keeps at most `keep` rotated files.
	if _, err := os.Stat(path + ".4"); err == nil {
		t.Fatalf("kept more rotated files than requested")
	}
}

func TestOversizedLineIsWrittenWhole(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rostalk.log")
	writer, err := New(path, 8, 1)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	line := "a line that is much longer than the limit\n"
	if _, err := writer.Write([]byte(line)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	_ = writer.Close()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != line {
		t.Fatalf("active file = %q, want the whole line", data)
	}
}

func TestNewRequiresAPath(t *testing.T) {
	if _, err := New("", 0, 0); err == nil {
		t.Fatal("an empty path must be rejected")
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 4)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
