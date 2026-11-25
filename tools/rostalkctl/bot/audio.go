package bot

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
)

// DefaultFrequency is the tone the bot publishes when no file is given.
const DefaultFrequency = 440

// frameSource produces mu-law frames of FrameBytes bytes. next returns nil when
// the source is exhausted.
type frameSource interface {
	next() []byte
}

// newSource builds the configured source.
func newSource(file string, frequency float64, loop bool) (frameSource, error) {
	if file != "" {
		return loadWAV(file, loop)
	}
	if frequency <= 0 {
		frequency = DefaultFrequency
	}
	if frequency >= SampleRate/2 {
		return nil, fmt.Errorf("bot: tone frequency %.0f Hz does not fit the %d Hz sample rate", frequency, SampleRate)
	}
	return &toneSource{frequency: frequency}, nil
}

// toneSource is a sine tone encoded to G.711 mu-law.
type toneSource struct {
	frequency float64
	phase     float64
}

func (t *toneSource) next() []byte {
	frame := make([]byte, FrameBytes)
	for i := range frame {
		sample := math.Sin(t.phase*2*math.Pi) * 0.1
		t.phase += t.frequency / SampleRate
		frame[i] = linearToUlaw(int16(sample * math.MaxInt16))
	}
	return frame
}

// silence is a full-scale-zero mu-law byte.
const silence = 0xFF

func silentFrame() []byte {
	frame := make([]byte, FrameBytes)
	for i := range frame {
		frame[i] = silence
	}
	return frame
}

// wavSource plays a PCM WAV file, downmixed to mono and resampled to 8 kHz.
type wavSource struct {
	frames [][]byte
	index  int
	loop   bool
}

func (w *wavSource) next() []byte {
	if w.index >= len(w.frames) {
		if !w.loop || len(w.frames) == 0 {
			return nil
		}
		w.index = 0
	}
	frame := w.frames[w.index]
	w.index++
	return frame
}

// loadWAV reads a PCM RIFF/WAVE file and converts it to mu-law frames.
//
// Only uncompressed PCM is supported (8 or 16 bit); that is what test fixtures
// use, and pulling an audio decoder into the CLI is not worth it.
func loadWAV(path string, loop bool) (frameSource, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("bot: read %q: %w", path, err)
	}
	samples, err := decodeWAV(data)
	if err != nil {
		return nil, fmt.Errorf("bot: %q: %w", path, err)
	}
	return &wavSource{frames: encodeFrames(samples), loop: loop}, nil
}

type wavFormat struct {
	channels   int
	sampleRate int
	bits       int
}

// decodeWAV returns mono float samples at 8 kHz.
func decodeWAV(data []byte) ([]float64, error) {
	if len(data) < 12 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return nil, errors.New("not a RIFF/WAVE file")
	}
	var (
		format    wavFormat
		payload   []byte
		haveFmt   bool
		haveAudio bool
	)
	for offset := 12; offset+8 <= len(data); {
		id := string(data[offset : offset+4])
		size := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
		body := offset + 8
		if size < 0 || body+size > len(data) {
			return nil, fmt.Errorf("chunk %q is truncated", id)
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return nil, errors.New("the fmt chunk is too short")
			}
			format = wavFormat{
				channels:   int(binary.LittleEndian.Uint16(data[body+2:])),
				sampleRate: int(binary.LittleEndian.Uint32(data[body+4:])),
				bits:       int(binary.LittleEndian.Uint16(data[body+14:])),
			}
			if codec := binary.LittleEndian.Uint16(data[body:]); codec != 1 {
				return nil, fmt.Errorf("compressed WAV (format %d) is not supported; use PCM", codec)
			}
			haveFmt = true
		case "data":
			payload = data[body : body+size]
			haveAudio = true
		}
		// Chunks are word aligned.
		offset = body + size
		if size%2 == 1 {
			offset++
		}
	}
	if !haveFmt || !haveAudio {
		return nil, errors.New("the file has no fmt or data chunk")
	}
	if format.channels < 1 || format.sampleRate < 1 {
		return nil, errors.New("the fmt chunk is invalid")
	}
	if format.bits != 8 && format.bits != 16 {
		return nil, fmt.Errorf("%d-bit PCM is not supported; use 8 or 16 bit", format.bits)
	}

	mixed := mixdown(payload, format)
	return resample(mixed, format.sampleRate, SampleRate), nil
}

// mixdown averages the channels and normalises the samples to [-1, 1].
func mixdown(payload []byte, format wavFormat) []float64 {
	bytesPerSample := format.bits / 8
	frameSize := bytesPerSample * format.channels
	if frameSize <= 0 {
		return nil
	}
	count := len(payload) / frameSize
	out := make([]float64, count)
	for i := 0; i < count; i++ {
		sum := 0.0
		for channel := 0; channel < format.channels; channel++ {
			start := i*frameSize + channel*bytesPerSample
			if format.bits == 8 {
				// 8-bit WAV is unsigned.
				sum += (float64(payload[start]) - 128) / 128
				continue
			}
			sample := int16(binary.LittleEndian.Uint16(payload[start:]))
			sum += float64(sample) / math.MaxInt16
		}
		out[i] = sum / float64(format.channels)
	}
	return out
}

// resample converts to the target rate with linear interpolation. The bot plays
// a tone or a test fixture, so the quality of a proper resampler is not needed.
func resample(samples []float64, from, to int) []float64 {
	if from == to || len(samples) == 0 {
		return samples
	}
	ratio := float64(from) / float64(to)
	count := int(float64(len(samples)) / ratio)
	out := make([]float64, count)
	for i := 0; i < count; i++ {
		position := float64(i) * ratio
		index := int(position)
		frac := position - float64(index)
		next := index + 1
		if next >= len(samples) {
			next = index
		}
		out[i] = samples[index]*(1-frac) + samples[next]*frac
	}
	return out
}

// encodeFrames slices mono samples into mu-law frames of FrameBytes.
func encodeFrames(samples []float64) [][]byte {
	var frames [][]byte
	for start := 0; start < len(samples); start += FrameBytes {
		frame := make([]byte, FrameBytes)
		for i := 0; i < FrameBytes; i++ {
			if start+i >= len(samples) {
				frame[i] = silence
				continue
			}
			frame[i] = linearToUlaw(int16(samples[start+i] * math.MaxInt16 * 0.9))
		}
		frames = append(frames, frame)
	}
	return frames
}

// linearToUlaw encodes one 16-bit sample as G.711 mu-law.
func linearToUlaw(sample int16) byte {
	const (
		bias = 0x84
		clip = 32635
	)
	sign := byte(0)
	value := int(sample)
	if value < 0 {
		value = -value
		sign = 0x80
	}
	if value > clip {
		value = clip
	}
	value += bias
	exponent := 7
	for mask := 0x4000; exponent > 0 && value&mask == 0; mask >>= 1 {
		exponent--
	}
	mantissa := (value >> (exponent + 3)) & 0x0F
	return ^(sign | byte(exponent<<4) | byte(mantissa))
}
