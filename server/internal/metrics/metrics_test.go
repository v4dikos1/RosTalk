package metrics

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

func TestRegistryExposesRosTalkGauges(t *testing.T) {
	reg := Registry(Source{
		Version: "test-version",
		Snapshot: func(context.Context) Snapshot {
			return Snapshot{
				OnlineUsers:       7,
				Channels:          4,
				MediaRooms:        3,
				MediaParticipants: 5,
				MediaTracks:       2,
			}
		},
	})
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	want := map[string]float64{
		"rostalk_online_users":       7,
		"rostalk_channels":           4,
		"rostalk_media_rooms":        3,
		"rostalk_media_participants": 5,
		"rostalk_media_tracks":       2,
	}
	for _, family := range families {
		if family.GetType().String() != "GAUGE" {
			continue
		}
		metric := family.GetMetric()[0]
		if value, ok := want[family.GetName()]; ok {
			if got := metric.GetGauge().GetValue(); got != value {
				t.Errorf("%s = %v, want %v", family.GetName(), got, value)
			}
			delete(want, family.GetName())
		}
	}
	for name := range want {
		t.Errorf("gauge %s is missing", name)
	}
}

func TestStartServesLocalMetricsAndStops(t *testing.T) {
	reg := Registry(Source{Snapshot: func(context.Context) Snapshot {
		return Snapshot{OnlineUsers: 1}
	}})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server, err := Start("127.0.0.1:0", reg, logger)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if server == nil {
		t.Fatal("Start returned no server")
	}
	defer func() { _ = server.Close(context.Background()) }()

	response, err := http.Get("http://" + server.Addr().String() + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if !strings.Contains(string(body), "rostalk_online_users 1") {
		t.Fatalf("body does not contain the gauge:\n%s", body)
	}
}

func TestOffDisablesTheEndpoint(t *testing.T) {
	server, err := Start(Off, prometheus.NewRegistry(), nil)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if server != nil {
		t.Fatal("off must return no server")
	}
}
