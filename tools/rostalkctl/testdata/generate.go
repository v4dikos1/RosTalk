//go:build ignore

// Command generate writes testdata/quality.wav: a short, deterministic,
// royalty-free signal for the voice quality end-to-end test (stage 2.3.1).
//
// It is not real speech and contains no third-party audio: three tones shaped
// by a syllable envelope, so the client can detect dropouts, level changes and
// the 660 Hz carrier while RTP loss and jitter are measured over a minute.
//
// Run from tools/rostalkctl:
//
//	go run testdata/generate.go
package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
)

const (
	sampleRate = 48_000
	seconds    = 12
	amplitude  = 0.3
)

func main() {
	path := filepath.Join("testdata", "quality.wav")
	total := sampleRate * seconds
	samples := make([]int16, total)
	for index := 0; index < total; index++ {
		t := float64(index) / sampleRate
		// Syllable envelope: 220 ms on, 280 ms off, 10 ms raised-cosine edges.
		position := math.Mod(t, 0.5)
		envelope := 0.0
		switch {
		case position < 0.22:
			envelope = 1
		case position < 0.23:
			envelope = 0.5 - 0.5*math.Cos(math.Pi*(position-0.22)/0.01)
		case position > 0.49:
			envelope = 1 - (0.5 - 0.5*math.Cos(math.Pi*(position-0.49)/0.01))
		}
		// Harmonics of 220 Hz plus a 660 Hz carrier; the mixture has enough
		// spectral structure to notice a dropout or a resampling artefact.
		value := 0.55*math.Sin(2*math.Pi*220*t) +
			0.3*math.Sin(2*math.Pi*660*t) +
			0.15*math.Sin(2*math.Pi*1320*t)
		samples[index] = int16(value * amplitude * envelope * math.MaxInt16)
	}

	data := make([]byte, 44+len(samples)*2)
	copy(data[0:4], "RIFF")
	binary.LittleEndian.PutUint32(data[4:8], uint32(36+len(samples)*2))
	copy(data[8:12], "WAVE")
	copy(data[12:16], "fmt ")
	binary.LittleEndian.PutUint32(data[16:20], 16)
	binary.LittleEndian.PutUint16(data[20:22], 1) // PCM
	binary.LittleEndian.PutUint16(data[22:24], 1) // mono
	binary.LittleEndian.PutUint32(data[24:28], sampleRate)
	binary.LittleEndian.PutUint32(data[28:32], sampleRate*2) // byte rate
	binary.LittleEndian.PutUint16(data[32:34], 2)            // block align
	binary.LittleEndian.PutUint16(data[34:36], 16)           // bits
	copy(data[36:40], "data")
	binary.LittleEndian.PutUint32(data[40:44], uint32(len(samples)*2))
	for index, sample := range samples {
		binary.LittleEndian.PutUint16(data[44+index*2:], uint16(sample))
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s (%d bytes, %d s)\n", path, len(data), seconds)
}
