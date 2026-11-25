// Package nat opens the inbound ports RosTalk needs on a home router.
//
// Two protocols are supported: UPnP IGD (SOAP over HTTP after an SSDP search)
// and NAT-PMP (RFC 6886). Both are implemented with the standard library only.
// The server never depends on them: a VPS with a public address works with
// --nat=off, and a router that refuses does not stop the server, it only prints
// what to forward manually.
package nat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"time"
)

// Mapping is one port forward.
type Mapping struct {
	// Protocol is "tcp" or "udp".
	Protocol string
	// InternalPort is the port the server listens on.
	InternalPort int
	// ExternalPort is the advertised port; normally the same.
	ExternalPort int
	// Description appears in the router's port-forward list (UPnP only).
	Description string
}

// Options configure Forward.
type Options struct {
	// Mode is "auto", "upnp" or "pmp". "off" returns nil, no error.
	Mode string
	// LANIP is the address the router should forward to.
	LANIP string
	// Mappings to install.
	Mappings []Mapping
	// Lease is the requested lifetime; zero means one hour. NAT-PMP routers
	// ignore longer values.
	Lease  time.Duration
	Logger *slog.Logger
}

// Result describes a successful mapping.
type Result struct {
	Method     string // "upnp" or "pmp"
	Gateway    string // control URL or gateway IP
	ExternalIP net.IP
	Mappings   []Mapping
}

// Session is an installed set of mappings. Call Renew before the lease expires
// and Close on shutdown.
type Session struct {
	method   string
	upnp     *upnpService
	pmp      *pmpClient
	mappings []Mapping
	lease    time.Duration
	logger   *slog.Logger
	external net.IP
}

// Forward installs the mappings with UPnP or NAT-PMP. A failure is returned to
// the caller, which normally logs it and keeps serving.
func Forward(ctx context.Context, opts Options) (*Session, error) {
	switch opts.Mode {
	case "off", "":
		return nil, nil
	case "auto", "upnp", "pmp":
	default:
		return nil, fmt.Errorf("nat: unknown mode %q (off, auto, upnp or pmp)", opts.Mode)
	}
	if net.ParseIP(opts.LANIP) == nil || net.ParseIP(opts.LANIP).IsLoopback() {
		return nil, fmt.Errorf("nat: %q is not a usable LAN address", opts.LANIP)
	}
	if len(opts.Mappings) == 0 {
		return nil, errors.New("nat: no mappings requested")
	}
	lease := opts.Lease
	if lease <= 0 {
		lease = time.Hour
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	var upnpErr, pmpErr error
	if opts.Mode == "auto" || opts.Mode == "upnp" {
		session, err := forwardUPnP(ctx, opts, lease, logger)
		if err == nil {
			return session, nil
		}
		upnpErr = err
		logger.Debug("UPnP port mapping failed", "error", err)
	}
	if opts.Mode == "auto" || opts.Mode == "pmp" {
		session, err := forwardPMP(ctx, opts, lease, logger)
		if err == nil {
			return session, nil
		}
		pmpErr = err
		logger.Debug("NAT-PMP port mapping failed", "error", err)
	}
	return nil, fmt.Errorf("nat: could not forward ports automatically (UPnP: %v; NAT-PMP: %v); "+
		"forward them in the router or use a VPS with a public address", upnpErr, pmpErr)
}

// Result returns what was installed.
func (s *Session) Result() Result {
	if s == nil {
		return Result{}
	}
	return Result{Method: s.method, Gateway: s.gateway(), ExternalIP: s.external, Mappings: s.mappings}
}

func (s *Session) gateway() string {
	switch {
	case s.upnp != nil:
		return s.upnp.controlURL
	case s.pmp != nil:
		return s.pmp.addr.String()
	default:
		return ""
	}
}

// Renew refreshes the lease. UPnP mappings without a lease (0) do not need it;
// NAT-PMP always does.
func (s *Session) Renew(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if s.upnp != nil {
		for _, mapping := range s.mappings {
			if err := s.upnp.addMapping(ctx, mapping, s.lease); err != nil {
				return err
			}
		}
		return nil
	}
	if s.pmp != nil {
		for _, mapping := range s.mappings {
			if _, err := s.pmp.mapPort(ctx, mapping, s.lease); err != nil {
				return err
			}
		}
	}
	return nil
}

// Close removes the mappings. It is best effort: a router that is gone leaves
// the lease to expire.
func (s *Session) Close(ctx context.Context) error {
	if s == nil {
		return nil
	}
	var errs []error
	if s.upnp != nil {
		for _, mapping := range s.mappings {
			if err := s.upnp.deleteMapping(ctx, mapping); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if s.pmp != nil {
		for _, mapping := range s.mappings {
			if _, err := s.pmp.mapPort(ctx, mapping, 0); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("nat: remove mappings: %w", errors.Join(errs...))
	}
	return nil
}

// ExternalAddress asks the router for its public address without opening any
// port. doctor uses it; the server does not need it.
func ExternalAddress(ctx context.Context, mode string) (Result, error) {
	var upnpErr, pmpErr error
	if mode == "auto" || mode == "upnp" {
		service, err := discoverUPnP(ctx)
		if err == nil {
			ip, callErr := service.externalIP(ctx)
			if callErr == nil {
				return Result{Method: "upnp", Gateway: service.controlURL, ExternalIP: ip}, nil
			}
			err = callErr
		}
		upnpErr = err
	}
	if mode == "auto" || mode == "pmp" {
		client, err := discoverPMP()
		if err == nil {
			ip, callErr := client.externalAddress(ctx)
			if callErr == nil {
				return Result{Method: "pmp", Gateway: client.addr.String(), ExternalIP: ip}, nil
			}
			err = callErr
		}
		pmpErr = err
	}
	return Result{}, fmt.Errorf("nat: no router answered (UPnP: %w; NAT-PMP: %w)", upnpErr, pmpErr)
}

// description keeps router UIs readable and within the 64-character limit many
// IGDs impose.
func description(mapping Mapping) string {
	if mapping.Description != "" {
		return mapping.Description
	}
	return fmt.Sprintf("RosTalk %s %d", strings.ToUpper(mapping.Protocol), mapping.ExternalPort)
}
