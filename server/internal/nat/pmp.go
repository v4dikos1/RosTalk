package nat

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// NAT-PMP (RFC 6886) uses UDP 5351 on the default gateway.
const pmpPort = 5351

const (
	pmpOpExternalAddress = 0
	pmpOpMapUDP          = 1
	pmpOpMapTCP          = 2
)

type pmpClient struct {
	addr *net.UDPAddr
}

func forwardPMP(ctx context.Context, opts Options, lease time.Duration, logger *slog.Logger) (*Session, error) {
	client, err := discoverPMP()
	if err != nil {
		return nil, err
	}
	external, err := client.externalAddress(ctx)
	if err != nil {
		return nil, err
	}
	for _, mapping := range opts.Mappings {
		externalPort, err := client.mapPort(ctx, mapping, lease)
		if err != nil {
			return nil, err
		}
		if externalPort != 0 && externalPort != uint16(mapping.ExternalPort) {
			return nil, fmt.Errorf("NAT-PMP mapped %s to external port %d instead of %d; "+
				"set the server port or forward it manually", mapping.Protocol, externalPort, mapping.ExternalPort)
		}
	}
	logger.Info("ports forwarded with NAT-PMP",
		"gateway", client.addr.String(),
		"external_ip", external.String(),
		"ports", summarize(opts.Mappings),
	)
	return &Session{
		method:   "pmp",
		pmp:      client,
		mappings: opts.Mappings,
		lease:    lease,
		logger:   logger,
		external: external,
	}, nil
}

func discoverPMP() (*pmpClient, error) {
	gateway, err := defaultGateway()
	if err != nil {
		return nil, err
	}
	return &pmpClient{addr: &net.UDPAddr{IP: gateway, Port: pmpPort}}, nil
}

// defaultGateway parses /proc/net/route, the only portable-enough Linux way to
// find the router without opening netlink (which would need a new dependency).
func defaultGateway() (net.IP, error) {
	data, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return nil, fmt.Errorf("NAT-PMP: cannot read /proc/net/route: %w", err)
	}
	for _, line := range strings.Split(string(data), "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		if fields[1] != "00000000" {
			continue
		}
		value, err := strconv.ParseUint(fields[2], 16, 32)
		if err != nil {
			continue
		}
		// The kernel prints the address in host byte order.
		ip := net.IPv4(byte(value&0xff), byte(value>>8&0xff), byte(value>>16&0xff), byte(value>>24&0xff))
		if ip.Equal(net.IPv4zero) {
			continue
		}
		return ip, nil
	}
	return nil, errors.New("NAT-PMP: no default gateway in /proc/net/route")
}

func (c *pmpClient) exchange(ctx context.Context, request []byte, wantOpcode byte) ([]byte, error) {
	conn, err := net.Dial("udp", c.addr.String())
	if err != nil {
		return nil, fmt.Errorf("NAT-PMP: dial %s: %w", c.addr, err)
	}
	defer func() { _ = conn.Close() }()

	timeout := 250 * time.Millisecond
	for attempt := 0; attempt < 3; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		deadline := time.Now().Add(timeout)
		if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
			deadline = d
		}
		_ = conn.SetDeadline(deadline)
		if _, err := conn.Write(request); err != nil {
			return nil, fmt.Errorf("NAT-PMP: send: %w", err)
		}
		buf := make([]byte, 32)
		n, err := conn.Read(buf)
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				timeout *= 2
				continue
			}
			return nil, fmt.Errorf("NAT-PMP: receive: %w", err)
		}
		if n < 8 {
			return nil, errors.New("NAT-PMP: short response")
		}
		if buf[1] != wantOpcode {
			continue
		}
		result := binary.BigEndian.Uint16(buf[2:4])
		if result != 0 {
			return nil, fmt.Errorf("NAT-PMP: router refused the request: %s", pmpResultText(result))
		}
		return buf[:n], nil
	}
	return nil, errors.New("NAT-PMP: router did not answer")
}

func pmpResultText(code uint16) string {
	switch code {
	case 1:
		return "unsupported version or opcode"
	case 2:
		return "not authorized or refused"
	case 3:
		return "network failure"
	case 4:
		return "out of resources"
	case 5:
		return "unsupported opcode"
	default:
		return fmt.Sprintf("error code %d", code)
	}
}

func (c *pmpClient) externalAddress(ctx context.Context) (net.IP, error) {
	response, err := c.exchange(ctx, []byte{0, pmpOpExternalAddress, 0, 0}, pmpOpExternalAddress|0x80)
	if err != nil {
		return nil, err
	}
	if len(response) < 12 {
		return nil, errors.New("NAT-PMP: short external address response")
	}
	ip := net.IPv4(response[8], response[9], response[10], response[11])
	if ip.IsUnspecified() {
		return nil, errors.New("NAT-PMP: router has no public address (no internet connection?)")
	}
	return ip, nil
}

func (c *pmpClient) mapPort(ctx context.Context, mapping Mapping, lease time.Duration) (uint16, error) {
	opcode := byte(pmpOpMapUDP)
	if strings.EqualFold(mapping.Protocol, "tcp") {
		opcode = pmpOpMapTCP
	}
	request := make([]byte, 12)
	request[1] = opcode
	binary.BigEndian.PutUint16(request[4:6], uint16(mapping.InternalPort))
	binary.BigEndian.PutUint16(request[6:8], uint16(mapping.ExternalPort))
	binary.BigEndian.PutUint32(request[8:12], uint32(lease.Seconds()))
	response, err := c.exchange(ctx, request, opcode|0x80)
	if err != nil {
		return 0, fmt.Errorf("NAT-PMP %s/%d: %w", mapping.Protocol, mapping.ExternalPort, err)
	}
	if len(response) < 16 {
		return 0, errors.New("NAT-PMP: short mapping response")
	}
	return binary.BigEndian.Uint16(response[10:12]), nil
}
