package nickname

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		fallback string
		want     string
		wantErr  bool
	}{
		{name: "trims", raw: "  alice  ", want: "alice"},
		{name: "fallback keeps previous", raw: "   ", fallback: "alice", want: "alice"},
		{name: "required", raw: "  ", wantErr: true},
		{name: "rejects newlines", raw: "ali\nce", wantErr: true},
		{name: "rejects tabs", raw: "ali\tce", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Normalize(tc.raw, tc.fallback)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("Normalize(%q) = %q, want error", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Normalize(%q): %v", tc.raw, err)
			}
			if got != tc.want {
				t.Fatalf("Normalize(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestNormalizeTruncatesLongNames(t *testing.T) {
	long := ""
	for i := 0; i < MaxRunes+10; i++ {
		long += "я"
	}
	got, err := Normalize(long, "")
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if runes := []rune(got); len(runes) != MaxRunes {
		t.Fatalf("long name has %d runes, want %d", len(runes), MaxRunes)
	}
}
