// Command rostalk-server is the RosTalk server: control plane, embedded media
// backend and administration CLI, all in one process and one binary.
//
// Stage 1.2 ships the control-plane core: SQLite store, TLS without a domain,
// the HTTPS/WSS gateway, the Ed25519 handshake and a one-time administrator
// invite link. Channels and media arrive in stages 1.3-1.4.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/adminsock"
	"github.com/v4dikos1/RosTalk/server/internal/legacy"
	"github.com/v4dikos1/RosTalk/server/internal/logging"
	"github.com/v4dikos1/RosTalk/server/internal/media"
	"github.com/v4dikos1/RosTalk/server/internal/metrics"
	"github.com/v4dikos1/RosTalk/server/internal/server"
	"github.com/v4dikos1/RosTalk/server/internal/store"
	"github.com/v4dikos1/RosTalk/server/internal/version"
)

const usage = `rostalk-server — self-hosted RosTalk voice server

Usage:
  rostalk-server <command> [flags]

Commands:
  run          Start the server
  admin        Administer a running server through its local Unix socket
  invite       Create an invite link offline (kept for bootstrapping)
  link         Print the pending administrator invite link
  healthcheck  Probe the local /healthz endpoint through TLS
  doctor       Diagnose ports, NAT and reachability
  backup       Write a consistent archive of the data directory
  restore      Restore an archive into a data directory
  update       Download, verify and install a signed release
  version      Print the build identity
  help         Print this text

Admin commands (talk to <data>/rostalk-admin.sock):
  admin invite create --role <role> [--max-uses N] [--expires DURATION]
  admin user list
  admin ban [--user ID] [--key HEX] [--ip ADDR] [--reason TEXT] [--expires DURATION]
  admin unban [--user ID] [--key HEX] [--ip ADDR]
  admin settings get [--key NAME]
  admin settings set <key> <value>
  admin token create --name NAME [--role ROLE] [--expires DURATION]
  admin token list

Run "rostalk-server run --help" for the flags of the server.

Every flag has an environment variable equivalent:
  --data                 ROSTALK_DATA
  --listen               ROSTALK_LISTEN
  --admin-socket         ROSTALK_ADMIN_SOCKET
  --public-host          ROSTALK_PUBLIC_HOST
  --domain               ROSTALK_DOMAIN
  --acme-email           ROSTALK_ACME_EMAIL
  --advertise-ip         ROSTALK_ADVERTISE_IP
  --enable-loopback-candidate  ROSTALK_LOOPBACK
  --login-mode           ROSTALK_LOGIN_MODE
  --server-password      ROSTALK_SERVER_PASSWORD
  --media-signal-port    ROSTALK_MEDIA_SIGNAL_PORT
  --media-udp-port       ROSTALK_MEDIA_UDP_PORT
  --media-tcp-port       ROSTALK_MEDIA_TCP_PORT
  --media-batch-io       ROSTALK_MEDIA_BATCH_IO
  --nat                  ROSTALK_NAT
  --metrics-addr         ROSTALK_METRICS_ADDR
  --log-file             ROSTALK_LOG_FILE
  --log-max-size         ROSTALK_LOG_MAX_SIZE
  --log-keep             ROSTALK_LOG_KEEP
  --new-year-disabled    ROSTALK_NEW_YEAR_DISABLED
  --new-year-tz          ROSTALK_NEW_YEAR_TZ
`

func main() {
	if err := execute(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "rostalk-server: %v\n", err)
		os.Exit(1)
	}
}

// execute runs one CLI invocation. It is split out of main so tests can drive
// the command line without spawning a process.
func execute(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		_, _ = fmt.Fprint(stderr, usage)
		return errors.New("a subcommand is required (run, version, help)")
	}

	switch args[0] {
	case "run":
		cfg, err := parseRunConfig(args[1:], stderr)
		if err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		return runServer(cfg, stdout, stderr)
	case "admin":
		return runAdmin(args[1:], stdout, stderr)
	case "invite":
		return runInvite(args[1:], stdout, stderr)
	case "link":
		return runLink(args[1:], stdout, stderr)
	case "healthcheck":
		return runHealthcheck(args[1:], stdout, stderr)
	case "backup":
		return runBackup(args[1:], stdout, stderr)
	case "restore":
		return runRestore(args[1:], stdout, stderr)
	case "update":
		return runUpdate(args[1:], stdout, stderr)
	case "doctor":
		return runDoctor(args[1:], stdout, stderr)
	case "version":
		printVersion(stdout)
		return nil
	case "help", "-h", "--help":
		_, _ = fmt.Fprint(stdout, usage)
		return nil
	default:
		_, _ = fmt.Fprint(stderr, usage)
		return fmt.Errorf("unknown subcommand %q", args[0])
	}
}

// runConfig holds everything `rostalk-server run` reads from its command line or
// the environment. No configuration files: everything else lives in the
// settings table (design 4.5).
type runConfig struct {
	// dataDir is where the database, identity keys, certificates and the
	// pending admin invite live.
	dataDir string
	// adminSocket is the local admin CLI socket path; empty means the default
	// inside dataDir, "off" disables it.
	adminSocket string
	// listen is the HTTPS/WSS address of the control plane (design 4.1).
	listen string
	// publicHost is the host (optional port) clients use in invite links.
	publicHost string
	// domain switches to ACME; a stub in stage 1.2.
	domain string
	// acmeEmail is the optional ACME account contact.
	acmeEmail string
	// acmeHTTPAddr and acmeTLSAddr are the challenge listeners (:80, :443).
	acmeHTTPAddr string
	acmeTLSAddr  string
	// advertiseIP is the address the media backend announces for ICE; on a
	// Windows dev host it is the LAN IP of the host, never 127.0.0.1 (ADR 0001).
	advertiseIP string
	// enableLoopbackCandidate lets the media backend offer loopback candidates.
	enableLoopbackCandidate bool
	// loginMode overrides the stored admission policy: invite, password or open.
	loginMode string
	// serverPassword is the plain password for password login. It is hashed by
	// the server and never logged.
	serverPassword string
	// mediaSignalPort is the loopback signalling port of the embedded SFU; the
	// gateway proxies /rtc to it (design 4.1).
	mediaSignalPort int
	// mediaUDPPort is the single UDP media port (7882 by default).
	mediaUDPPort int
	// mediaTCPPort is the ICE-TCP fallback port (7881 by default).
	mediaTCPPort int
	// mediaBatchIO enables batched UDP writes in the embedded SFU.
	mediaBatchIO bool
	// natMode asks the router for port forwards: off, auto, upnp or pmp.
	natMode string
	// metricsAddr is the local Prometheus listener; "off" disables it.
	metricsAddr string
	// logFile is the optional size-rotated log file next to stderr.
	logFile string
	// logMaxSize and logKeep configure the rotation of logFile.
	logMaxSize int64
	logKeep    int
	// newYearDisabled leaves the New Year event out of this server.
	newYearDisabled bool
	// newYearTZ is the IANA timezone of the event calendar.
	newYearTZ string
}

func parseRunConfig(args []string, stderr io.Writer) (runConfig, error) {
	envLoop, err := envBool("ROSTALK_LOOPBACK", false)
	if err != nil {
		return runConfig{}, err
	}
	envBatchIO, err := envBool("ROSTALK_MEDIA_BATCH_IO", true)
	if err != nil {
		return runConfig{}, err
	}
	envNewYearOff, err := envBool("ROSTALK_NEW_YEAR_DISABLED", false)
	if err != nil {
		return runConfig{}, err
	}
	cfg := runConfig{
		newYearDisabled:         envNewYearOff,
		newYearTZ:               envString("ROSTALK_NEW_YEAR_TZ", ""),
		dataDir:                 envString("ROSTALK_DATA", "./data"),
		adminSocket:             envString("ROSTALK_ADMIN_SOCKET", ""),
		listen:                  envString("ROSTALK_LISTEN", ":7443"),
		publicHost:              envString("ROSTALK_PUBLIC_HOST", ""),
		domain:                  envString("ROSTALK_DOMAIN", ""),
		acmeEmail:               envString("ROSTALK_ACME_EMAIL", ""),
		acmeHTTPAddr:            envString("ROSTALK_ACME_HTTP_ADDR", ""),
		acmeTLSAddr:             envString("ROSTALK_ACME_TLS_ADDR", ""),
		advertiseIP:             envString("ROSTALK_ADVERTISE_IP", ""),
		enableLoopbackCandidate: envLoop,
		loginMode:               envString("ROSTALK_LOGIN_MODE", ""),
		serverPassword:          envString("ROSTALK_SERVER_PASSWORD", ""),
		mediaSignalPort:         envInt("ROSTALK_MEDIA_SIGNAL_PORT", media.DefaultSignalPort),
		mediaUDPPort:            envInt("ROSTALK_MEDIA_UDP_PORT", media.DefaultUDPPort),
		mediaTCPPort:            envInt("ROSTALK_MEDIA_TCP_PORT", media.DefaultTCPPort),
		mediaBatchIO:            envBatchIO,
		natMode:                 envString("ROSTALK_NAT", "off"),
		metricsAddr:             envString("ROSTALK_METRICS_ADDR", metrics.DefaultAddr),
		logFile:                 envString("ROSTALK_LOG_FILE", ""),
		logMaxSize:              int64(envInt("ROSTALK_LOG_MAX_SIZE", int(logging.DefaultMaxSize))),
		logKeep:                 envInt("ROSTALK_LOG_KEEP", logging.DefaultKeep),
	}

	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&cfg.dataDir, "data", cfg.dataDir,
		"directory for the database, identity keys, certificates and invites (ROSTALK_DATA)")
	fs.StringVar(&cfg.adminSocket, "admin-socket", cfg.adminSocket,
		"local admin CLI socket path; empty uses <data>/rostalk-admin.sock, \"off\" disables it (ROSTALK_ADMIN_SOCKET)")
	fs.StringVar(&cfg.listen, "listen", cfg.listen,
		"HTTPS/WSS listen address (ROSTALK_LISTEN)")
	fs.StringVar(&cfg.publicHost, "public-host", cfg.publicHost,
		"host or host:port clients use in invite links; use the LAN IP in dev, never localhost (ROSTALK_PUBLIC_HOST, ADR 0001)")
	fs.StringVar(&cfg.domain, "domain", cfg.domain,
		"serve TLS with an automatic Let's Encrypt certificate for this domain; invite links then carry no fp (ROSTALK_DOMAIN)")
	fs.StringVar(&cfg.acmeEmail, "acme-email", cfg.acmeEmail,
		"optional ACME account contact (ROSTALK_ACME_EMAIL)")
	fs.StringVar(&cfg.acmeHTTPAddr, "acme-http-addr", cfg.acmeHTTPAddr,
		"HTTP-01 challenge listen address, default :80 (ROSTALK_ACME_HTTP_ADDR)")
	fs.StringVar(&cfg.acmeTLSAddr, "acme-tls-addr", cfg.acmeTLSAddr,
		"TLS-ALPN-01 challenge listen address, default :443 (ROSTALK_ACME_TLS_ADDR)")
	fs.StringVar(&cfg.advertiseIP, "advertise-ip", cfg.advertiseIP,
		"IP the media backend announces for ICE; also a fallback for --public-host (ROSTALK_ADVERTISE_IP, ADR 0001)")
	fs.BoolVar(&cfg.enableLoopbackCandidate, "enable-loopback-candidate", cfg.enableLoopbackCandidate,
		"offer loopback ICE candidates; keep false when --advertise-ip is not a loopback address (ROSTALK_LOOPBACK, ADR 0001)")
	fs.StringVar(&cfg.loginMode, "login-mode", cfg.loginMode,
		"admission policy written to the settings table: invite, password or open (ROSTALK_LOGIN_MODE)")
	fs.StringVar(&cfg.serverPassword, "server-password", cfg.serverPassword,
		"server password for password login; hashed with argon2id and never logged (ROSTALK_SERVER_PASSWORD)")
	fs.IntVar(&cfg.mediaSignalPort, "media-signal-port", cfg.mediaSignalPort,
		"loopback signalling port of the embedded media backend (ROSTALK_MEDIA_SIGNAL_PORT)")
	fs.IntVar(&cfg.mediaUDPPort, "media-udp-port", cfg.mediaUDPPort,
		"UDP media port (ROSTALK_MEDIA_UDP_PORT)")
	fs.IntVar(&cfg.mediaTCPPort, "media-tcp-port", cfg.mediaTCPPort,
		"ICE-TCP fallback port (ROSTALK_MEDIA_TCP_PORT)")
	fs.BoolVar(&cfg.mediaBatchIO, "media-batch-io", cfg.mediaBatchIO,
		"batch UDP writes in the embedded SFU, on by default (ROSTALK_MEDIA_BATCH_IO)")
	fs.StringVar(&cfg.natMode, "nat", cfg.natMode,
		"ask the router to forward the ports: off, auto, upnp or pmp; home hosting only, not inside Docker (ROSTALK_NAT)")
	fs.StringVar(&cfg.metricsAddr, "metrics-addr", cfg.metricsAddr,
		"local Prometheus listener, 127.0.0.1:9090 by default; \"off\" disables it and it is never public (ROSTALK_METRICS_ADDR)")
	fs.StringVar(&cfg.logFile, "log-file", cfg.logFile,
		"write logs to this size-rotated file as well as stderr; empty keeps stderr only (ROSTALK_LOG_FILE)")
	fs.Int64Var(&cfg.logMaxSize, "log-max-size", cfg.logMaxSize,
		"rotate the log file after this many bytes (ROSTALK_LOG_MAX_SIZE)")
	fs.IntVar(&cfg.logKeep, "log-keep", cfg.logKeep,
		"how many rotated log files to keep (ROSTALK_LOG_KEEP)")
	fs.BoolVar(&cfg.newYearDisabled, "new-year-disabled", cfg.newYearDisabled,
		"leave the New Year event out: no routes, hooks or loop (ROSTALK_NEW_YEAR_DISABLED)")
	fs.StringVar(&cfg.newYearTZ, "new-year-tz", cfg.newYearTZ,
		"IANA timezone of the New Year calendar; empty uses TZ, then UTC; fixed per season on first start (ROSTALK_NEW_YEAR_TZ)")

	if err := fs.Parse(args); err != nil {
		return runConfig{}, err
	}
	if fs.NArg() > 0 {
		return runConfig{}, fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if _, _, err := net.SplitHostPort(cfg.listen); err != nil {
		return runConfig{}, fmt.Errorf("invalid --listen address %q: %w", cfg.listen, err)
	}
	if cfg.dataDir == "" {
		return runConfig{}, errors.New("--data must not be empty")
	}
	if cfg.advertiseIP != "" && net.ParseIP(cfg.advertiseIP) == nil {
		return runConfig{}, fmt.Errorf("--advertise-ip %q is not an IP address", cfg.advertiseIP)
	}
	switch cfg.loginMode {
	case "", "invite", "password", "open":
	default:
		return runConfig{}, fmt.Errorf("--login-mode %q is not one of invite, password, open", cfg.loginMode)
	}
	if cfg.serverPassword != "" && cfg.loginMode != "password" {
		return runConfig{}, errors.New("--server-password only applies to --login-mode=password")
	}
	for name, port := range map[string]int{
		"--media-signal-port": cfg.mediaSignalPort,
		"--media-udp-port":    cfg.mediaUDPPort,
		"--media-tcp-port":    cfg.mediaTCPPort,
	} {
		if port <= 0 || port > 65535 {
			return runConfig{}, fmt.Errorf("%s=%d is out of range", name, port)
		}
	}
	switch cfg.natMode {
	case "off", "auto", "upnp", "pmp":
	default:
		return runConfig{}, fmt.Errorf("--nat=%q must be off, auto, upnp or pmp", cfg.natMode)
	}
	if cfg.metricsAddr != "" && cfg.metricsAddr != metrics.Off {
		if _, _, err := net.SplitHostPort(cfg.metricsAddr); err != nil {
			return runConfig{}, fmt.Errorf("invalid --metrics-addr %q: %w", cfg.metricsAddr, err)
		}
	}
	if cfg.logMaxSize <= 0 {
		return runConfig{}, errors.New("--log-max-size must be positive")
	}
	if cfg.logKeep < 0 {
		return runConfig{}, errors.New("--log-keep must not be negative")
	}

	return cfg, nil
}

// adminFlags are the flags every admin subcommand shares.
type adminFlags struct {
	dataDir string
	socket  string
	fs      *flag.FlagSet
}

func newAdminFlags(name string, stderr io.Writer) *adminFlags {
	flags := &adminFlags{}
	flags.fs = flag.NewFlagSet(name, flag.ContinueOnError)
	flags.fs.SetOutput(stderr)
	flags.dataDir = envString("ROSTALK_DATA", "./data")
	flags.socket = envString("ROSTALK_ADMIN_SOCKET", "")
	flags.fs.StringVar(&flags.dataDir, "data", flags.dataDir, "server data directory (ROSTALK_DATA)")
	flags.fs.StringVar(&flags.socket, "socket", flags.socket,
		"admin socket path; empty uses <data>/rostalk-admin.sock (ROSTALK_ADMIN_SOCKET)")
	return flags
}

func (f *adminFlags) socketPath() string {
	if f.socket != "" {
		return f.socket
	}
	return filepath.Join(f.dataDir, adminsock.DefaultName)
}

// runAdmin executes `rostalk-server admin ...`. The command is checked on the
// running server, which owns the database; the CLI only formats the answer.
func runAdmin(args []string, stdout, stderr io.Writer) error {
	if len(args) < 2 {
		_, _ = fmt.Fprint(stderr, usage)
		return errors.New("usage: rostalk-server admin <invite|user|ban|unban|settings|token> <command>")
	}
	switch args[0] {
	case "invite":
		if args[1] != "create" {
			return fmt.Errorf("unknown admin invite command %q", args[1])
		}
		flags := newAdminFlags("admin invite create", stderr)
		role := flags.fs.String("role", "", "role granted on login (default Member)")
		maxUses := flags.fs.Int("max-uses", 1, "how many logins the invite admits")
		expires := flags.fs.Duration("expires", 24*time.Hour, "invite lifetime, 0 never expires")
		if err := flags.fs.Parse(args[2:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		data, err := adminsock.Call(flags.socketPath(), adminsock.Request{
			Command:        "invite.create",
			Role:           *role,
			MaxUses:        *maxUses,
			ExpiresSeconds: int64(expires.Seconds()),
		})
		if err != nil {
			return err
		}
		var result adminsock.InviteResult
		if err := json.Unmarshal(data, &result); err != nil {
			return fmt.Errorf("decode invite reply: %w", err)
		}
		_, _ = fmt.Fprintln(stdout, result.URL)
		return nil
	case "user":
		if args[1] != "list" {
			return fmt.Errorf("unknown admin user command %q", args[1])
		}
		flags := newAdminFlags("admin user list", stderr)
		if err := flags.fs.Parse(args[2:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		data, err := adminsock.Call(flags.socketPath(), adminsock.Request{Command: "user.list"})
		if err != nil {
			return err
		}
		var rows []adminsock.UserRow
		if err := json.Unmarshal(data, &rows); err != nil {
			return fmt.Errorf("decode user list: %w", err)
		}
		_, _ = fmt.Fprintln(stdout, "ID\tNICKNAME\tONLINE\tROLES\tLAST_SEEN_MS")
		for _, row := range rows {
			roles := row.RoleNames
			if len(roles) == 0 {
				for _, id := range row.RoleIDs {
					roles = append(roles, strconv.FormatInt(id, 10))
				}
			}
			_, _ = fmt.Fprintf(stdout, "%d\t%s\t%t\t%s\t%d\n",
				row.ID, row.Nickname, row.Online, strings.Join(roles, ","), row.LastSeenUnix)
		}
		return nil
	case "ban":
		flags := newAdminFlags("admin ban", stderr)
		userID := flags.fs.Int64("user", 0, "user id to ban")
		key := flags.fs.String("key", "", "public key in hex to ban")
		ip := flags.fs.String("ip", "", "address to ban")
		reason := flags.fs.String("reason", "", "reason shown in the audit log")
		expires := flags.fs.Duration("expires", 0, "ban lifetime, 0 means permanent")
		if err := flags.fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if *userID == 0 && *key == "" && *ip == "" {
			return errors.New("ban needs --user, --key or --ip")
		}
		_, err := adminsock.Call(flags.socketPath(), adminsock.Request{
			Command:        "ban",
			UserID:         *userID,
			PublicKey:      *key,
			IP:             *ip,
			Reason:         *reason,
			ExpiresSeconds: int64(expires.Seconds()),
		})
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintln(stdout, "banned")
		return nil
	case "unban":
		flags := newAdminFlags("admin unban", stderr)
		userID := flags.fs.Int64("user", 0, "user id to unban")
		key := flags.fs.String("key", "", "public key in hex to unban")
		ip := flags.fs.String("ip", "", "address to unban")
		if err := flags.fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if *userID == 0 && *key == "" && *ip == "" {
			return errors.New("unban needs --user, --key or --ip")
		}
		_, err := adminsock.Call(flags.socketPath(), adminsock.Request{
			Command:   "unban",
			UserID:    *userID,
			PublicKey: *key,
			IP:        *ip,
		})
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintln(stdout, "unbanned")
		return nil
	case "settings":
		return runAdminSettings(args[1:], stdout, stderr)
	case "token":
		return runAdminToken(args[1:], stdout, stderr)
	default:
		return fmt.Errorf("unknown admin command %q", args[0])
	}
}

func runAdminToken(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: rostalk-server admin token create|list")
	}
	switch args[0] {
	case "create":
		flags := newAdminFlags("admin token create", stderr)
		name := flags.fs.String("name", "", "human-readable token name")
		role := flags.fs.String("role", "", "role the token acts as (default Member)")
		expires := flags.fs.Duration("expires", 0, "token lifetime, 0 means never expires")
		if err := flags.fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		if *name == "" {
			return errors.New("token create needs --name")
		}
		data, err := adminsock.Call(flags.socketPath(), adminsock.Request{
			Command:        "token.create",
			Name:           *name,
			Role:           *role,
			ExpiresSeconds: int64(expires.Seconds()),
		})
		if err != nil {
			return err
		}
		var result adminsock.TokenResult
		if err := json.Unmarshal(data, &result); err != nil {
			return fmt.Errorf("decode token reply: %w", err)
		}
		// The plaintext token appears here once. Print only it on stdout so a
		// script can capture it; never write it to a log.
		_, _ = fmt.Fprintln(stdout, result.Token)
		return nil
	case "list":
		flags := newAdminFlags("admin token list", stderr)
		if err := flags.fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		data, err := adminsock.Call(flags.socketPath(), adminsock.Request{Command: "token.list"})
		if err != nil {
			return err
		}
		var rows []adminsock.TokenRow
		if err := json.Unmarshal(data, &rows); err != nil {
			return fmt.Errorf("decode token list: %w", err)
		}
		_, _ = fmt.Fprintln(stdout, "ID\tNAME\tROLE\tEXPIRES_AT_MS\tREVOKED_AT_MS\tLAST_USED_AT_MS")
		for _, row := range rows {
			_, _ = fmt.Fprintf(stdout, "%d\t%s\t%d\t%d\t%d\t%d\n",
				row.ID, row.Name, row.RoleID, row.ExpiresAt, row.RevokedAt, row.LastUsedAt)
		}
		return nil
	default:
		return fmt.Errorf("unknown admin token command %q", args[0])
	}
}

func runAdminSettings(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: rostalk-server admin settings get|set")
	}
	switch args[0] {
	case "get":
		flags := newAdminFlags("admin settings get", stderr)
		key := flags.fs.String("key", "", "print only this setting")
		if err := flags.fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		data, err := adminsock.Call(flags.socketPath(), adminsock.Request{Command: "settings.get"})
		if err != nil {
			return err
		}
		var settings adminsock.SettingsResult
		if err := json.Unmarshal(data, &settings); err != nil {
			return fmt.Errorf("decode settings: %w", err)
		}
		values := map[string]string{
			"server_name":            settings.ServerName,
			"login_mode":             settings.LoginMode,
			"max_users":              strconv.FormatUint(uint64(settings.MaxUsers), 10),
			"password_set":           strconv.FormatBool(settings.PasswordSet),
			"message_retention_days": strconv.Itoa(settings.MessageRetentionDays),
			"max_attachment_bytes":   strconv.FormatInt(settings.MaxAttachmentBytes, 10),
			"attachment_quota_bytes": strconv.FormatInt(settings.AttachmentQuotaBytes, 10),
		}
		names := []string{
			"server_name", "login_mode", "max_users", "password_set",
			"message_retention_days", "max_attachment_bytes", "attachment_quota_bytes",
		}
		for _, name := range names {
			if *key != "" && *key != name {
				continue
			}
			_, _ = fmt.Fprintf(stdout, "%s=%s\n", name, values[name])
		}
		return nil
	case "set":
		flags := newAdminFlags("admin settings set", stderr)
		flagKey := flags.fs.String("key", "", "setting name")
		flagValue := flags.fs.String("value", "", "setting value")
		if err := flags.fs.Parse(args[1:]); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil
			}
			return err
		}
		key := *flagKey
		value := *flagValue
		if key == "" {
			rest := flags.fs.Args()
			if len(rest) != 2 {
				return errors.New("usage: rostalk-server admin settings set <key> <value>")
			}
			key, value = rest[0], rest[1]
		}
		_, err := adminsock.Call(flags.socketPath(), adminsock.Request{
			Command: "settings.set",
			Key:     key,
			Value:   value,
		})
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintln(stdout, "updated")
		return nil
	default:
		return fmt.Errorf("unknown admin settings command %q", args[0])
	}
}

// runInvite prints a join link for a new user. It opens the data directory of a
// running or stopped server; the link carries the same host and certificate
// fingerprint the server advertises (ADR 0001: never localhost in dev).
func runInvite(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("invite", flag.ContinueOnError)
	fs.SetOutput(stderr)
	dataDir := fs.String("data", envString("ROSTALK_DATA", "./data"), "server data directory (ROSTALK_DATA)")
	listen := fs.String("listen", envString("ROSTALK_LISTEN", ":7443"), "listen address used in the link port (ROSTALK_LISTEN)")
	publicHost := fs.String("public-host", envString("ROSTALK_PUBLIC_HOST", ""), "host clients connect to (ROSTALK_PUBLIC_HOST)")
	advertiseIP := fs.String("advertise-ip", envString("ROSTALK_ADVERTISE_IP", ""), "fallback host and media address (ROSTALK_ADVERTISE_IP)")
	domain := fs.String("domain", envString("ROSTALK_DOMAIN", ""), "domain mode: no fp in the link (ROSTALK_DOMAIN)")
	admin := fs.Bool("admin", false, "grant administrator rights to whoever uses the link")
	maxUses := fs.Int("max-uses", server.DefaultInviteMaxUses, "how many logins the invite admits")
	expires := fs.Duration("expires", 24*time.Hour, "how long the invite stays valid (0 never expires)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if *maxUses < 1 {
		return errors.New("--max-uses must be at least 1")
	}

	opts := store.InviteOptions{GrantAdmin: *admin, MaxUses: *maxUses}
	if *expires > 0 {
		deadline := time.Now().Add(*expires)
		opts.ExpiresAt = &deadline
	}
	link, err := server.CreateInvite(context.Background(), server.Config{
		DataDir:     *dataDir,
		Listen:      *listen,
		PublicHost:  *publicHost,
		AdvertiseIP: *advertiseIP,
		Domain:      *domain,
	}, opts)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(stdout, link)
	return nil
}

// runServer starts the control plane, prints the one-time administrator invite
// link to stdout (never to the log, which also carries no tokens) and blocks
// until SIGINT/SIGTERM.
func runServer(cfg runConfig, stdout, stderr io.Writer) error {
	logSink := stderr
	var logFile *logging.RotatingWriter
	if cfg.logFile != "" {
		file, err := logging.New(cfg.logFile, cfg.logMaxSize, cfg.logKeep)
		if err != nil {
			return err
		}
		logFile = file
		logSink = io.MultiWriter(stderr, file)
	}
	logger := slog.New(slog.NewTextHandler(logSink, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if logFile != nil {
		defer func() {
			if closeErr := logFile.Close(); closeErr != nil {
				_, _ = fmt.Fprintf(stderr, "rostalk-server: close the log file: %v\n", closeErr)
			}
		}()
	}

	app, err := server.New(server.Config{
		DataDir:                 cfg.dataDir,
		Listen:                  cfg.listen,
		AdminSocket:             cfg.adminSocket,
		Domain:                  cfg.domain,
		ACMEEmail:               cfg.acmeEmail,
		ACMEHTTPAddr:            cfg.acmeHTTPAddr,
		ACMETLSAddr:             cfg.acmeTLSAddr,
		ACMEDirectoryURL:        envString("ROSTALK_ACME_DIRECTORY", ""),
		PublicHost:              cfg.publicHost,
		AdvertiseIP:             cfg.advertiseIP,
		EnableLoopbackCandidate: cfg.enableLoopbackCandidate,
		LoginMode:               cfg.loginMode,
		ServerPassword:          cfg.serverPassword,
		MediaSignalPort:         cfg.mediaSignalPort,
		MediaUDPPort:            cfg.mediaUDPPort,
		MediaTCPPort:            cfg.mediaTCPPort,
		DisableMediaBatchIO:     !cfg.mediaBatchIO,
		NATMode:                 cfg.natMode,
		MetricsAddr:             cfg.metricsAddr,
		Version:                 version.String(),
		Logger:                  logger,
		NewYearDisabled:         cfg.newYearDisabled,
		NewYearTZ:               cfg.newYearTZ,
	})
	if err != nil {
		return err
	}

	shutdown := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if closeErr := app.Close(ctx); closeErr != nil {
			logger.Warn("shutdown did not finish cleanly", "error", closeErr)
		}
	}

	if err := app.Start(context.Background()); err != nil {
		shutdown()
		return err
	}

	if link := app.AdminInviteLink(); link != "" {
		_, _ = fmt.Fprintf(stdout, `
RosTalk first start: administrator invite (single use)
  %s
Whoever opens this link becomes an administrator.

`, link)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	logger.Info("shutting down")
	shutdown()
	return nil
}

// lookupEnv reads a ROSTALK_* variable, accepting the pre-rename HEARTH_* name
// with a one-time warning (ADR 0033), so an old systemd unit keeps working.
func lookupEnv(name string) (string, bool) {
	value, ok, legacyName := legacy.LookupEnv(name)
	if legacyName != "" {
		if _, seen := warnedEnv.LoadOrStore(legacyName, true); !seen {
			slog.Warn("deprecated environment variable; rename it", "old", legacyName, "new", name)
		}
	}
	return value, ok
}

var warnedEnv sync.Map

func envString(name, fallback string) string {
	if value, ok := lookupEnv(name); ok {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value, ok := lookupEnv(name)
	if !ok {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envBool(name string, fallback bool) (bool, error) {
	value, ok := lookupEnv(name)
	if !ok {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s=%q is not a boolean", name, value)
	}
	return parsed, nil
}
