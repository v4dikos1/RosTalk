// Package metrics exposes the server's Prometheus endpoint on a local address.
//
// The embedded LiveKit server registers its own collectors in the Prometheus
// default registry during startup (ADR 0001, trap 3). This package adds the
// RosTalk control-plane gauges and serves both registries together.
//
// The endpoint is local on purpose: the metrics describe capacity and user
// counts and are not part of the public HTTPS gateway (stage 7.1). The
// installer and the default flag bind 127.0.0.1; an operator who changes the
// address is warned in the log.
package metrics

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// DefaultAddr is the loopback listener used when no address is configured.
const DefaultAddr = "127.0.0.1:9090"

// Off disables the endpoint.
const Off = "off"

// Snapshot is one reading of the control plane and the media plane.
type Snapshot struct {
	// OnlineUsers is the number of authenticated users.
	OnlineUsers int
	// Channels is the number of channels in the tree.
	Channels int
	// MediaRooms, MediaParticipants and MediaTracks describe the SFU. A nil
	// Media function (a test backend without Rooms) leaves them at zero.
	MediaRooms        int
	MediaParticipants int
	MediaTracks       int
}

// Source provides the values for one scrape.
type Source struct {
	// Snapshot builds a reading. It must be cheap: Prometheus calls it on
	// every scrape (once every 15 s in the shipped configuration).
	Snapshot func(context.Context) Snapshot
	// Version is reported in rostalk_build_info.
	Version string
}

// Registry builds a collector registry with the RosTalk gauges. The LiveKit
// collectors stay in the default registry and are gathered alongside.
func Registry(source Source) *prometheus.Registry {
	reg := prometheus.NewRegistry()

	// Every gauge is collected separately by the registry, but one scrape must
	// not enumerate the media rooms five times. The reading is cached for a
	// second, which is well below the Prometheus scrape interval.
	var (
		cacheMu     sync.Mutex
		cached      Snapshot
		cachedAt    time.Time
		hasSnapshot bool
	)
	current := func() Snapshot {
		cacheMu.Lock()
		defer cacheMu.Unlock()
		if hasSnapshot && time.Since(cachedAt) < time.Second {
			return cached
		}
		cached = source.current()
		cachedAt = time.Now()
		hasSnapshot = true
		return cached
	}

	users := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "rostalk_online_users",
		Help: "Authenticated users currently connected to the control plane.",
	}, func() float64 { return float64(current().OnlineUsers) })

	channels := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "rostalk_channels",
		Help: "Channels in the server tree.",
	}, func() float64 { return float64(current().Channels) })

	rooms := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "rostalk_media_rooms",
		Help: "Media rooms the SFU currently knows about.",
	}, func() float64 { return float64(current().MediaRooms) })

	participants := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "rostalk_media_participants",
		Help: "Media participants connected to the SFU.",
	}, func() float64 { return float64(current().MediaParticipants) })

	tracks := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "rostalk_media_tracks",
		Help: "Tracks published in the SFU.",
	}, func() float64 { return float64(current().MediaTracks) })

	reg.MustRegister(users, channels, rooms, participants, tracks)

	if source.Version != "" {
		info := prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "rostalk_build_info",
			Help: "Build identity of the running server.",
		}, []string{"version"})
		info.WithLabelValues(source.Version).Set(1)
		reg.MustRegister(info)
	}
	return reg
}

// current reads the source with a short bound. A media backend that is slow or
// shutting down must not hang a scrape: the gauge stays at its last value.
func (s Source) current() Snapshot {
	if s.Snapshot == nil {
		return Snapshot{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return s.Snapshot(ctx)
}

// Server is the running local metrics listener.
type Server struct {
	httpServer *http.Server
	listener   net.Listener
	logger     *slog.Logger
}

// Start binds addr and serves the metrics in the background. An empty addr or
// "off" returns (nil, nil): metrics are disabled. The command line supplies
// DefaultAddr, so a server embedded in a test does not bind a port by accident.
func Start(addr string, reg *prometheus.Registry, logger *slog.Logger) (*Server, error) {
	if addr == Off || addr == "" {
		return nil, nil
	}
	if logger == nil {
		logger = slog.Default()
	}
	if !isLoopbackAddr(addr) {
		logger.Warn("the metrics endpoint is not on a loopback address; "+
			"anyone who can reach it sees capacity and user counts",
			"addr", addr)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("metrics: listen on %q: %w", addr, err)
	}
	gatherers := prometheus.Gatherers{prometheus.DefaultGatherer, reg}
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(gatherers, promhttp.HandlerOpts{
		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte("RosTalk metrics: /metrics\n"))
	})

	s := &Server{
		httpServer: &http.Server{
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    16 << 10,
		},
		listener: ln,
		logger:   logger,
	}
	go func() {
		err := s.httpServer.Serve(ln)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("metrics endpoint stopped", "error", err)
		}
	}()
	logger.Info("metrics listening", "addr", ln.Addr().String())
	return s, nil
}

// Addr returns the bound address, nil when metrics are off.
func (s *Server) Addr() net.Addr {
	if s == nil {
		return nil
	}
	return s.listener.Addr()
}

// Close stops the listener.
func (s *Server) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	return s.httpServer.Shutdown(ctx)
}

// isLoopbackAddr reports whether the listen address only reaches the local
// machine. An empty host means every interface and is not loopback.
func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
