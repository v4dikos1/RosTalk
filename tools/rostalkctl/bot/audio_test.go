package bot

import (
	"testing"
)

func TestWAVSourceStopsAtTheEnd(t *testing.T) {
	source := &wavSource{frames: [][]byte{{1}, {2}}}
	if got := source.next(); len(got) != 1 || got[0] != 1 {
		t.Fatalf("first frame = %v", got)
	}
	if got := source.next(); len(got) != 1 || got[0] != 2 {
		t.Fatalf("second frame = %v", got)
	}
	if got := source.next(); got != nil {
		t.Fatalf("expected the source to end, got %v", got)
	}
}

func TestWAVSourceLoopsWhenRequested(t *testing.T) {
	source := &wavSource{frames: [][]byte{{1}, {2}}, loop: true}
	var got []byte
	for range 3 {
		got = source.next()
	}
	if len(got) != 1 || got[0] != 1 {
		t.Fatalf("looped frame = %v, want the first frame again", got)
	}
}

func TestQualityFixtureIsLoadable(t *testing.T) {
	source, err := loadWAV("../testdata/quality.wav", false)
	if err != nil {
		t.Fatalf("loadWAV: %v", err)
	}
	frames := 0
	for source.next() != nil {
		frames++
		if frames > 10_000 {
			t.Fatal("the fixture does not end")
		}
	}
	// 12 s at 8 kHz in 160-byte (20 ms) frames.
	if frames != 600 {
		t.Fatalf("fixture has %d frames, want 600", frames)
	}
}
