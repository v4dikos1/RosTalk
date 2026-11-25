package doctor

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/v4dikos1/RosTalk/server/internal/netutil"
)

type okTransport struct{}

func (okTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("ok\n")), Header: make(http.Header)}, nil
}

func TestOfflineReportFailsOnLoopbackInviteHost(t *testing.T) {
	report := Run(context.Background(), Options{
		DataDir:    t.TempDir(),
		Listen:     "127.0.0.1:1",
		PublicHost: "127.0.0.1",
		Offline:    true,
	})
	if !report.Failed() {
		t.Fatalf("a loopback invite host did not fail: %+v", report.Checks)
	}
	found := false
	for _, check := range report.Checks {
		if check.Name == "invite host" && check.Status == StatusFail {
			found = true
		}
		if check.Name == "external checks" && check.Status != StatusInfo {
			t.Errorf("offline external check is not informational: %+v", check)
		}
	}
	if !found {
		t.Fatalf("no failing invite host check: %+v", report.Checks)
	}
}

func TestOfflineReportAcceptsLANHost(t *testing.T) {
	report := Run(context.Background(), Options{
		DataDir:    t.TempDir(),
		Listen:     "127.0.0.1:1",
		PublicHost: "192.0.2.10",
		Offline:    true,
	})
	for _, check := range report.Checks {
		if check.Name == "invite host" && check.Status != StatusOK {
			t.Fatalf("LAN host rejected: %+v", check)
		}
	}
}

func TestHealthAndPorts(t *testing.T) {
	dir := t.TempDir()
	if _, err := netutil.LoadOrCreateTLS(dir, []string{"192.0.2.10"}); err != nil {
		t.Fatal(err)
	}
	if err := writeFakeDB(dir); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	port := listener.Addr().(*net.TCPAddr).Port

	report := Run(context.Background(), Options{
		DataDir:    dir,
		Listen:     "127.0.0.1:" + strconv.Itoa(port),
		PublicHost: "192.0.2.10",
		Offline:    true,
		HTTP:       &http.Client{Transport: okTransport{}},
	})
	var health *Check
	for i := range report.Checks {
		if report.Checks[i].Name == "health" {
			health = &report.Checks[i]
		}
	}
	if health == nil || health.Status != StatusOK {
		t.Fatalf("health check did not pass: %+v", report.Checks)
	}
	var control *Check
	for i := range report.Checks {
		if strings.HasPrefix(report.Checks[i].Name, "control port") {
			control = &report.Checks[i]
		}
	}
	if control == nil || control.Status != StatusOK {
		t.Fatalf("control port check did not pass: %+v", report.Checks)
	}
}

func TestPortChecksReportBusyPort(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	port := listener.Addr().(*net.TCPAddr).Port
	check := checkTCPPort("control port", port, false)
	if check.Status != StatusFail {
		t.Fatalf("a busy port is not reported as a failure: %+v", check)
	}
}

func TestLoopbackDetection(t *testing.T) {
	for _, host := range []string{"localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]:7443"} {
		if !isLoopbackHost(host) {
			t.Errorf("%q was not recognised as loopback/unspecified", host)
		}
	}
	for _, host := range []string{"192.0.2.1", "rostalk.example.test", "203.0.113.5:7443"} {
		if isLoopbackHost(host) {
			t.Errorf("%q was treated as loopback", host)
		}
	}
}

func TestRecvBufferCheck(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rmem_max")
	previous := recvBufferPath
	recvBufferPath = path
	t.Cleanup(func() { recvBufferPath = previous })

	if err := os.WriteFile(path, []byte("425984\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	low := checkRecvBuffer()
	if low.Status != StatusWarn || !strings.Contains(low.Detail, "425984") {
		t.Fatalf("small receive buffer = %+v, want a warning", low)
	}
	if !strings.Contains(low.Fix, "sysctl") {
		t.Fatalf("warning does not show the fix: %+v", low)
	}

	if err := os.WriteFile(path, []byte("5242880\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if check := checkRecvBuffer(); check.Status != StatusOK {
		t.Fatalf("5 MiB receive buffer = %+v, want ok", check)
	}

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if check := checkRecvBuffer(); check.Status != StatusInfo {
		t.Fatalf("missing proc entry = %+v, want info", check)
	}
}

func TestListenPort(t *testing.T) {
	if port, err := listenPort(":7443"); err != nil || port != 7443 {
		t.Fatalf("listenPort(:7443) = %d, %v", port, err)
	}
	if port, err := listenPort("127.0.0.1:0"); err != nil || port != 0 {
		t.Fatalf("listenPort(random) = %d, %v", port, err)
	}
	if _, err := listenPort("7443"); err == nil {
		t.Fatal("a listen address without a port was accepted")
	}
}

func writeFakeDB(dir string) error {
	return os.WriteFile(filepath.Join(dir, "rostalk.db"), []byte("fake"), 0o600)
}
