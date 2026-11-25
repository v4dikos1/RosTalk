// Package doctor answers the questions of a self-hoster: are the ports free,
// is the server answering, does the router forward them, is the public address
// reachable, and what does the firewall look like. It never changes anything:
// every fix is printed, not applied.
package doctor

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/legacy"
	"github.com/v4dikos1/RosTalk/server/internal/nat"
	"github.com/v4dikos1/RosTalk/server/internal/netutil"
)

// Status is the severity of one check.
type Status string

const (
	StatusOK   Status = "ok"
	StatusWarn Status = "warn"
	StatusFail Status = "fail"
	StatusInfo Status = "info"
)

// Check is one diagnostic line.
type Check struct {
	Name   string
	Status Status
	Detail string
	Fix    string
}

// Report is the result of a doctor run.
type Report struct {
	Checks []Check
	// PublicHost is what invite links would use.
	PublicHost string
}

// Failed reports whether at least one check is a failure.
func (r Report) Failed() bool {
	for _, check := range r.Checks {
		if check.Status == StatusFail {
			return true
		}
	}
	return false
}

// Options configure Run.
type Options struct {
	DataDir    string
	Listen     string
	PublicHost string
	Domain     string
	// NATMode is auto, upnp, pmp or off. auto is the default.
	NATMode string
	// Offline skips every external probe (STUN, router, public reachability);
	// tests and air-gapped machines use it.
	Offline bool
	// HTTP overrides the health check client.
	HTTP *http.Client
}

// Run performs the checks. It is intentionally sequential: the output is read
// by a human, and the external probes have short timeouts.
func Run(ctx context.Context, opts Options) Report {
	var report Report
	if opts.Listen == "" {
		opts.Listen = ":7443"
	}
	if opts.NATMode == "" {
		opts.NATMode = "auto"
	}

	controlPort, err := listenPort(opts.Listen)
	if err != nil {
		report.Checks = append(report.Checks, Check{
			Name: "listen address", Status: StatusFail, Detail: err.Error(),
			Fix: "use --listen=:7443 (or another host:port)",
		})
		return report
	}

	report.PublicHost = resolveHost(opts)
	report.Checks = append(report.Checks, checkPublicHost(report.PublicHost, opts.Domain))
	report.Checks = append(report.Checks, checkDataDir(opts.DataDir))
	report.Checks = append(report.Checks, checkFirewall(opts.Domain))

	healthy := checkHealth(ctx, opts, &report)
	report.Checks = append(report.Checks, checkPorts(healthy, controlPort)...)
	report.Checks = append(report.Checks, checkRecvBuffer())

	if lan := netutil.DetectLANIP(); lan != "" {
		report.Checks = append(report.Checks, Check{Name: "LAN address", Status: StatusInfo, Detail: lan})
	} else {
		report.Checks = append(report.Checks, Check{
			Name: "LAN address", Status: StatusWarn,
			Detail: "no non-loopback IPv4 address found",
			Fix:    "clients on the LAN cannot reach this host without an address",
		})
	}

	if opts.Offline {
		report.Checks = append(report.Checks, Check{
			Name: "external checks", Status: StatusInfo,
			Detail: "skipped (--offline)",
		})
		return report
	}

	external, stunCheck := checkSTUN(ctx)
	report.Checks = append(report.Checks, stunCheck)
	if check := checkRouter(ctx, opts.NATMode, external); check != nil {
		report.Checks = append(report.Checks, *check)
	}
	if external != "" && controlPort != 0 {
		report.Checks = append(report.Checks, checkPublicReachability(ctx, external, controlPort))
	}
	if inContainer() {
		report.Checks = append(report.Checks, Check{
			Name: "container", Status: StatusInfo,
			Detail: "running inside a container: --nat cannot see the router",
			Fix:    "publish 7443/tcp, 7881/tcp and 7882/udp with docker -p (or the compose ports section)",
		})
	}
	return report
}

func listenPort(listen string) (int, error) {
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return 0, fmt.Errorf("invalid --listen address %q: %w", listen, err)
	}
	if port == "" || port == "0" {
		return 0, nil
	}
	var n int
	if _, err := fmt.Sscanf(port, "%d", &n); err != nil || n <= 0 || n > 65535 {
		return 0, fmt.Errorf("invalid port %q in --listen", port)
	}
	return n, nil
}

func resolveHost(opts Options) string {
	if opts.PublicHost != "" {
		return opts.PublicHost
	}
	if opts.Domain != "" {
		return opts.Domain
	}
	return netutil.DetectLANIP()
}

func checkPublicHost(host, domain string) Check {
	name := "invite host"
	switch {
	case host == "":
		return Check{Name: name, Status: StatusFail, Detail: "no public host could be determined",
			Fix: "pass --public-host=<LAN or public IP> (or --domain); localhost never works for clients on another machine"}
	case isLoopbackHost(host):
		return Check{Name: name, Status: StatusFail, Detail: host + " is a loopback address",
			Fix: "use the LAN or public address, or --domain=rostalk.example.com"}
	case domain != "":
		return Check{Name: name, Status: StatusOK, Detail: host + " (domain mode, no fingerprint in links)"}
	default:
		return Check{Name: name, Status: StatusOK, Detail: host + " (links carry the certificate fingerprint)"}
	}
}

func isLoopbackHost(host string) bool {
	only := netutil.NormalizeHost(host)
	if strings.EqualFold(only, "localhost") {
		return true
	}
	ip := net.ParseIP(only)
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}

func checkDataDir(dir string) Check {
	name := "data directory"
	if dir == "" {
		return Check{Name: name, Status: StatusFail, Detail: "not configured",
			Fix: "pass --data=/var/lib/rostalk"}
	}
	info, err := os.Stat(dir)
	if err != nil {
		return Check{Name: name, Status: StatusFail, Detail: err.Error(),
			Fix: "start the server once (it creates the directory) or run deploy/install.sh"}
	}
	if !info.IsDir() {
		return Check{Name: name, Status: StatusFail, Detail: dir + " is not a directory"}
	}
	var missing []string
	for _, file := range []string{legacy.DatabaseName, netutil.ServerCertFile, netutil.ServerKeyFile} {
		if _, err := os.Stat(filepath.Join(dir, file)); err != nil {
			// The server renames a pre-rename database on its next start.
			if file == legacy.DatabaseName {
				if _, legacyErr := os.Stat(filepath.Join(dir, legacy.LegacyDatabaseName)); legacyErr == nil {
					continue
				}
			}
			missing = append(missing, file)
		}
	}
	if len(missing) > 0 {
		return Check{Name: name, Status: StatusWarn, Detail: dir + " is missing " + strings.Join(missing, ", "),
			Fix: "start the server once so it creates its identity and database"}
	}
	return Check{Name: name, Status: StatusOK, Detail: dir}
}

func checkHealth(ctx context.Context, opts Options, report *Report) bool {
	port, err := listenPort(opts.Listen)
	if err != nil || port == 0 {
		return false
	}
	url := fmt.Sprintf("https://127.0.0.1:%d/healthz", port)
	if opts.Domain != "" {
		// The certificate is issued for the public domain, not for loopback.
		url = fmt.Sprintf("https://%s:%d/healthz", opts.Domain, port)
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if material, err := netutil.LoadTLS(opts.DataDir); err == nil {
		tlsConfig.RootCAs = material.CAPool()
	}
	client := opts.HTTP
	if client == nil {
		client = &http.Client{
			Timeout:   4 * time.Second,
			Transport: &http.Transport{TLSClientConfig: tlsConfig},
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := client.Do(req)
	if err != nil {
		report.Checks = append(report.Checks, Check{
			Name: "health", Status: StatusWarn, Detail: "the server does not answer on " + url,
			Fix: "start it: systemctl start rostalk-server (then check journalctl -u rostalk-server)",
		})
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		report.Checks = append(report.Checks, Check{Name: "health", Status: StatusFail, Detail: url + " returned " + resp.Status})
		return false
	}
	report.Checks = append(report.Checks, Check{Name: "health", Status: StatusOK, Detail: url + " answers 200"})
	return true
}

func checkPorts(healthy bool, controlPort int) []Check {
	var checks []Check
	if controlPort != 0 {
		checks = append(checks, checkTCPPort("control port", controlPort, healthy))
	}
	checks = append(checks, checkTCPPort("ICE-TCP fallback", 7881, healthy))
	checks = append(checks, checkUDPPort("media (UDP)", 7882, healthy))
	return checks
}

func checkTCPPort(name string, port int, healthy bool) Check {
	address := fmt.Sprintf("127.0.0.1:%d", port)
	if healthy {
		conn, err := net.DialTimeout("tcp", address, time.Second)
		if err == nil {
			_ = conn.Close()
			return Check{Name: name + fmt.Sprintf(" tcp/%d", port), Status: StatusOK, Detail: "accepting connections"}
		}
		return Check{Name: name + fmt.Sprintf(" tcp/%d", port), Status: StatusWarn, Detail: "the server is up but this port is closed",
			Fix: "check --media-tcp-port and the service log"}
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return Check{Name: name + fmt.Sprintf(" tcp/%d", port), Status: StatusFail, Detail: "in use by another process: " + err.Error(),
			Fix: "stop the other service or choose another port"}
	}
	_ = listener.Close()
	if conn, err := net.DialTimeout("tcp", address, 300*time.Millisecond); err == nil {
		_ = conn.Close()
		return Check{Name: name + fmt.Sprintf(" tcp/%d", port), Status: StatusFail, Detail: "another process accepts connections here",
			Fix: "stop the other service or choose another port"}
	}
	return Check{Name: name + fmt.Sprintf(" tcp/%d", port), Status: StatusInfo, Detail: "free; the server is not running"}
}

// RecommendedRecvBuffer is the smallest UDP receive buffer worth recommending.
// LiveKit asks the kernel for 16 MiB, but 5 MiB is enough for several hundred
// streams; the stock Linux default is 212992 bytes (425984 after doubling),
// which the SFU fills below that. The audit saw receive-buffer warnings on
// every stand with the default.
const RecommendedRecvBuffer = 5 * 1024 * 1024

// recvBufferPath is a variable so the test can point it at a fixture.
var recvBufferPath = "/proc/sys/net/core/rmem_max"

// checkRecvBuffer warns when net.core.rmem_max is below the recommended size.
// It is a warning, not a failure: media still flows, with more loss under load.
// The doctor never changes the sysctl.
func checkRecvBuffer() Check {
	name := "UDP receive buffer"
	data, err := os.ReadFile(recvBufferPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Check{Name: name, Status: StatusInfo,
				Detail: "net.core.rmem_max is not readable on this platform"}
		}
		return Check{Name: name, Status: StatusInfo,
			Detail: "cannot read net.core.rmem_max: " + err.Error()}
	}
	value, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || value < 0 {
		return Check{Name: name, Status: StatusInfo,
			Detail: "unexpected net.core.rmem_max value: " + strings.TrimSpace(string(data))}
	}
	if value < RecommendedRecvBuffer {
		return Check{
			Name:   name,
			Status: StatusWarn,
			Detail: fmt.Sprintf("net.core.rmem_max is %d bytes (%.1f MiB); the 425984-byte default overflows at a few hundred streams",
				value, float64(value)/(1024*1024)),
			Fix: "raise it to at least 5242880 bytes: sysctl -w net.core.rmem_max=5242880 (persist it in /etc/sysctl.d/99-rostalk.conf)",
		}
	}
	return Check{Name: name, Status: StatusOK,
		Detail: fmt.Sprintf("net.core.rmem_max is %d bytes (%.1f MiB)",
			value, float64(value)/(1024*1024))}
}

func checkUDPPort(name string, port int, healthy bool) Check {
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4zero, Port: port})
	if err != nil {
		if healthy {
			return Check{Name: name + fmt.Sprintf(" udp/%d", port), Status: StatusOK, Detail: "bound (probably by the running server)"}
		}
		return Check{Name: name + fmt.Sprintf(" udp/%d", port), Status: StatusFail, Detail: "in use by another process",
			Fix: "stop the other service or choose another port"}
	}
	_ = conn.Close()
	return Check{Name: name + fmt.Sprintf(" udp/%d", port), Status: StatusInfo, Detail: "free; the server is not running"}
}

// STUN servers are public and require no account. A UDP answer proves outbound
// UDP works and usually reveals the public address.
var stunServers = []string{"stun.l.google.com:19302", "stun.cloudflare.com:3478"}

func checkSTUN(ctx context.Context) (string, Check) {
	var lastErr error
	for _, server := range stunServers {
		probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		ip, port, err := nat.STUNExternalIP(probeCtx, server)
		cancel()
		if err == nil {
			return ip.String(), Check{
				Name: "UDP egress", Status: StatusOK,
				Detail: fmt.Sprintf("STUN %s sees %s:%d; UDP leaves the network", server, ip, port),
			}
		}
		lastErr = err
	}
	return "", Check{
		Name: "UDP egress", Status: StatusWarn,
		Detail: "STUN did not answer: " + lastErr.Error(),
		Fix:    "allow outbound UDP 3478/19302 or check the network; media may fall back to TCP 7881",
	}
}

func checkRouter(ctx context.Context, mode, stunExternal string) *Check {
	if mode == "off" {
		return nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	result, err := nat.ExternalAddress(probeCtx, mode)
	if err != nil {
		return &Check{
			Name: "router", Status: StatusInfo,
			Detail: "UPnP/NAT-PMP did not answer: " + err.Error(),
			Fix:    "forward TCP 7443, TCP 7881 and UDP 7882 in the router, or use a VPS",
		}
	}
	detail := fmt.Sprintf("%s reports the public address %s", result.Method, result.ExternalIP)
	if stunExternal != "" && result.ExternalIP.String() != stunExternal {
		return &Check{Name: "router", Status: StatusWarn, Detail: detail + ", STUN sees " + stunExternal,
			Fix: "the router may be behind another NAT (CGNAT); use a VPS or ask the provider for a public address"}
	}
	return &Check{Name: "router", Status: StatusOK, Detail: detail,
		Fix: "the server maps the ports itself when started with --nat=auto"}
}

func checkPublicReachability(ctx context.Context, external string, port int) Check {
	address := net.JoinHostPort(external, fmt.Sprint(port))
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var dialer net.Dialer
	conn, err := dialer.DialContext(probeCtx, "tcp", address)
	if err != nil {
		return Check{Name: "public reachability",
			Status: StatusWarn, Detail: "cannot connect to " + address + " from this machine: " + err.Error(),
			Fix: "many routers do not support hairpin NAT, so this is not proof of failure. Check from a phone on mobile data: https://" + address + "/healthz"}
	}
	_ = conn.Close()
	return Check{Name: "public reachability", Status: StatusOK, Detail: address + " accepted a TCP connection"}
}

func checkFirewall(domain string) Check {
	name := "firewall"
	want := []string{"7443", "7881", "7882"}
	if domain != "" {
		want = append(want, "80", "443")
	}
	if _, err := exec.LookPath("ufw"); err == nil {
		out, err := exec.Command("ufw", "status").CombinedOutput()
		text := string(out)
		if err != nil || strings.Contains(text, "ERROR") {
			return Check{Name: name, Status: StatusInfo, Detail: "ufw is installed; run as root to inspect its rules",
				Fix: "sudo ufw allow 7443/tcp && sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp"}
		}
		if !strings.Contains(text, "Status: active") {
			return Check{Name: name, Status: StatusInfo, Detail: "ufw is inactive"}
		}
		var missing []string
		for _, port := range want {
			if !strings.Contains(text, port) {
				missing = append(missing, port)
			}
		}
		if len(missing) > 0 {
			return Check{Name: name, Status: StatusWarn, Detail: "ufw is active and does not mention port(s) " + strings.Join(missing, ", "),
				Fix: "sudo ufw allow 7443/tcp && sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp"}
		}
		return Check{Name: name, Status: StatusOK, Detail: "ufw is active and allows the RosTalk ports"}
	}
	if _, err := exec.LookPath("firewall-cmd"); err == nil {
		out, err := exec.Command("firewall-cmd", "--state").CombinedOutput()
		if err != nil || !strings.Contains(string(out), "running") {
			return Check{Name: name, Status: StatusInfo, Detail: "firewalld is installed but not running"}
		}
		ports, err := exec.Command("firewall-cmd", "--list-ports").Output()
		if err != nil {
			return Check{Name: name, Status: StatusInfo, Detail: "firewalld is running; run as root to inspect its ports",
				Fix: "sudo firewall-cmd --permanent --add-port=7443/tcp --add-port=7881/tcp --add-port=7882/udp && sudo firewall-cmd --reload"}
		}
		list := string(ports)
		var missing []string
		for _, port := range want {
			if !strings.Contains(list, port) {
				missing = append(missing, port)
			}
		}
		if len(missing) > 0 {
			return Check{Name: name, Status: StatusWarn, Detail: "firewalld does not open port(s) " + strings.Join(missing, ", "),
				Fix: "sudo firewall-cmd --permanent --add-port=7443/tcp --add-port=7881/tcp --add-port=7882/udp && sudo firewall-cmd --reload"}
		}
		return Check{Name: name, Status: StatusOK, Detail: "firewalld opens the RosTalk ports"}
	}
	return Check{Name: name, Status: StatusInfo, Detail: "ufw and firewalld are not installed",
		Fix: "if you use nftables or a provider firewall, open TCP 7443, TCP 7881 and UDP 7882"}
}

func inContainer() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	data, err := os.ReadFile("/proc/1/cgroup")
	if err != nil {
		return false
	}
	text := string(data)
	return strings.Contains(text, "docker") || strings.Contains(text, "containerd") || strings.Contains(text, "kubepods")
}

// ErrReportedProblems is returned by the CLI when at least one check failed.
var ErrReportedProblems = errors.New("doctor found problems")
