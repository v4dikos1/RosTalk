package nat

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	ssdpAddress = "239.255.255.250:1900"
	// How long to collect SSDP answers.
	ssdpWindow = 2 * time.Second
)

// upnpService is one WANIPConnection/WANPPPConnection control endpoint.
type upnpService struct {
	controlURL  string
	serviceType string
	http        *http.Client
	lanIP       string
}

func forwardUPnP(ctx context.Context, opts Options, lease time.Duration, logger *slog.Logger) (*Session, error) {
	service, err := discoverUPnP(ctx)
	if err != nil {
		return nil, err
	}
	service.lanIP = opts.LANIP
	external, err := service.externalIP(ctx)
	if err != nil {
		return nil, err
	}
	for _, mapping := range opts.Mappings {
		if err := service.addMapping(ctx, mapping, lease); err != nil {
			return nil, err
		}
	}
	logger.Info("ports forwarded with UPnP",
		"gateway", service.controlURL,
		"external_ip", external.String(),
		"ports", summarize(opts.Mappings),
	)
	return &Session{
		method:   "upnp",
		upnp:     service,
		mappings: opts.Mappings,
		lease:    lease,
		logger:   logger,
		external: external,
	}, nil
}

func summarize(mappings []Mapping) string {
	parts := make([]string, 0, len(mappings))
	for _, mapping := range mappings {
		parts = append(parts, fmt.Sprintf("%s/%d", mapping.Protocol, mapping.ExternalPort))
	}
	return strings.Join(parts, ",")
}

// discoverUPnP finds the first router that offers a WAN connection service.
func discoverUPnP(ctx context.Context) (*upnpService, error) {
	locations, err := searchSSDP(ctx)
	if err != nil {
		return nil, err
	}
	var errs []error
	for _, location := range locations {
		service, err := fetchDescription(ctx, location)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		return service, nil
	}
	if len(errs) == 0 {
		return nil, errors.New("no UPnP router answered")
	}
	return nil, fmt.Errorf("no usable UPnP WAN connection service: %w", errors.Join(errs...))
}

// searchSSDP sends one M-SEARCH and collects LOCATION headers. The UDP socket
// is closed by the deadline, so a silent network costs ssdpWindow, not more.
func searchSSDP(ctx context.Context) ([]string, error) {
	conn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		return nil, fmt.Errorf("UPnP search: %w", err)
	}
	defer func() { _ = conn.Close() }()

	deadline := time.Now().Add(ssdpWindow)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)

	query := "M-SEARCH * HTTP/1.1\r\n" +
		"HOST: " + ssdpAddress + "\r\n" +
		"MAN: \"ssdp:discover\"\r\n" +
		"MX: 2\r\n" +
		"ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n"
	if _, err := conn.WriteTo([]byte(query), mustResolve(ssdpAddress)); err != nil {
		return nil, fmt.Errorf("UPnP search: %w", err)
	}

	var locations []string
	seen := map[string]bool{}
	// A second query catches routers that dropped the first datagram.
	retry := time.NewTimer(700 * time.Millisecond)
	defer retry.Stop()
	for {
		buf := make([]byte, 4096)
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				break
			}
			if ctx.Err() != nil {
				break
			}
			return nil, fmt.Errorf("UPnP search: %w", err)
		}
		location := headerValue(string(buf[:n]), "location")
		if location == "" || seen[location] {
			continue
		}
		seen[location] = true
		locations = append(locations, location)
		select {
		case <-retry.C:
			_, _ = conn.WriteTo([]byte(query), mustResolve(ssdpAddress))
		default:
		}
	}
	if len(locations) == 0 {
		return nil, errors.New("no UPnP router answered on the LAN")
	}
	return locations, nil
}

func mustResolve(address string) *net.UDPAddr {
	addr, err := net.ResolveUDPAddr("udp4", address)
	if err != nil {
		panic("nat: bad SSDP address: " + err.Error())
	}
	return addr
}

func headerValue(message, name string) string {
	for _, line := range strings.Split(message, "\r\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 && strings.EqualFold(strings.TrimSpace(parts[0]), name) {
			return strings.TrimSpace(parts[1])
		}
	}
	return ""
}

type deviceDescription struct {
	Device deviceNode `xml:"device"`
}

type deviceNode struct {
	DeviceType string        `xml:"deviceType"`
	Services   []serviceNode `xml:"serviceList>service"`
	Devices    []deviceNode  `xml:"deviceList>device"`
}

type serviceNode struct {
	ServiceType string `xml:"serviceType"`
	ControlURL  string `xml:"controlURL"`
}

// fetchDescription downloads the device description and looks for a WAN
// connection service, including nested devices (InternetGatewayDevice →
// WANDevice → WANConnectionDevice).
func fetchDescription(ctx context.Context, location string) (*upnpService, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("UPnP description %s: %w", location, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("UPnP description %s: %s", location, resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("UPnP description %s: %w", location, err)
	}
	var description deviceDescription
	if err := xml.Unmarshal(data, &description); err != nil {
		return nil, fmt.Errorf("UPnP description %s: %w", location, err)
	}
	service, ok := findWANService(description.Device)
	if !ok {
		return nil, fmt.Errorf("UPnP device at %s has no WANIPConnection service", location)
	}
	base, err := url.Parse(location)
	if err != nil {
		return nil, err
	}
	control, err := url.Parse(service.ControlURL)
	if err != nil {
		return nil, fmt.Errorf("UPnP control URL %q: %w", service.ControlURL, err)
	}
	return &upnpService{
		controlURL:  base.ResolveReference(control).String(),
		serviceType: service.ServiceType,
		http:        &http.Client{Timeout: 10 * time.Second},
	}, nil
}

func findWANService(device deviceNode) (serviceNode, bool) {
	for _, service := range device.Services {
		if strings.Contains(service.ServiceType, ":WANIPConnection:") ||
			strings.Contains(service.ServiceType, ":WANPPPConnection:") {
			return service, true
		}
	}
	for _, child := range device.Devices {
		if service, ok := findWANService(child); ok {
			return service, true
		}
	}
	return serviceNode{}, false
}

func (s *upnpService) externalIP(ctx context.Context) (net.IP, error) {
	values, err := s.call(ctx, "GetExternalIPAddress", nil)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(strings.TrimSpace(values["NewExternalIPAddress"]))
	if ip == nil || ip.IsUnspecified() {
		return nil, fmt.Errorf("UPnP router reported an invalid external address %q", values["NewExternalIPAddress"])
	}
	return ip, nil
}

func (s *upnpService) addMappingTo(ctx context.Context, mapping Mapping, lanIP string, lease time.Duration) error {
	leaseSeconds := int(lease.Seconds())
	args := map[string]string{
		"NewRemoteHost":             "",
		"NewExternalPort":           fmt.Sprint(mapping.ExternalPort),
		"NewProtocol":               strings.ToUpper(mapping.Protocol),
		"NewInternalPort":           fmt.Sprint(mapping.InternalPort),
		"NewInternalClient":         lanIP,
		"NewEnabled":                "1",
		"NewPortMappingDescription": description(mapping),
		"NewLeaseDuration":          fmt.Sprint(leaseSeconds),
	}
	if _, err := s.call(ctx, "AddPortMapping", args); err != nil {
		return fmt.Errorf("UPnP AddPortMapping %s/%d: %w", mapping.Protocol, mapping.ExternalPort, err)
	}
	return nil
}

// addMapping is the install/renewal path. The LAN address is stored on the
// service when Forward discovers it.
func (s *upnpService) addMapping(ctx context.Context, mapping Mapping, lease time.Duration) error {
	if s.lanIP == "" {
		return errors.New("UPnP: no LAN address for the mapping")
	}
	return s.addMappingTo(ctx, mapping, s.lanIP, lease)
}

func (s *upnpService) deleteMapping(ctx context.Context, mapping Mapping) error {
	args := map[string]string{
		"NewRemoteHost":   "",
		"NewExternalPort": fmt.Sprint(mapping.ExternalPort),
		"NewProtocol":     strings.ToUpper(mapping.Protocol),
	}
	if _, err := s.call(ctx, "DeletePortMapping", args); err != nil {
		return fmt.Errorf("UPnP DeletePortMapping %s/%d: %w", mapping.Protocol, mapping.ExternalPort, err)
	}
	return nil
}

// call sends one SOAP action and returns its scalar response elements.
func (s *upnpService) call(ctx context.Context, action string, args map[string]string) (map[string]string, error) {
	var body bytes.Buffer
	body.WriteString(`<?xml version="1.0"?>`)
	body.WriteString(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" `)
	body.WriteString(`s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>`)
	body.WriteString(`<u:` + action + ` xmlns:u="` + xmlEscape(s.serviceType) + `">`)
	for _, name := range sortedKeys(args) {
		body.WriteString(`<` + name + `>` + xmlEscape(args[name]) + `</` + name + `>`)
	}
	body.WriteString(`</u:` + action + `></s:Body></s:Envelope>`)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.controlURL, &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", `text/xml; charset="utf-8"`)
	req.Header.Set("SOAPAction", `"`+s.serviceType+"#"+action+`"`)
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		code, desc := soapError(data)
		if code != "" {
			return nil, fmt.Errorf("UPnP %s failed: %s %s", action, code, desc)
		}
		return nil, fmt.Errorf("UPnP %s: %s", action, resp.Status)
	}
	values := soapValues(data)
	if code := values["errorCode"]; code != "" {
		return nil, fmt.Errorf("UPnP %s failed: %s %s", action, code, values["errorDescription"])
	}
	return values, nil
}

// soapValues returns the text of every scalar element inside the SOAP body.
func soapValues(data []byte) map[string]string {
	values := map[string]string{}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var current string
	var text strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			break
		}
		switch t := token.(type) {
		case xml.StartElement:
			if t.Name.Space == "http://schemas.xmlsoap.org/soap/envelope/" || t.Name.Local == "Body" {
				continue
			}
			current = t.Name.Local
			text.Reset()
		case xml.CharData:
			if current != "" {
				text.Write(t)
			}
		case xml.EndElement:
			if current != "" && t.Name.Local == current {
				values[current] = text.String()
				current = ""
			}
		}
	}
	return values
}

func soapError(data []byte) (string, string) {
	values := soapValues(data)
	return values["errorCode"], values["errorDescription"]
}

func xmlEscape(value string) string {
	var buf bytes.Buffer
	_ = xml.EscapeText(&buf, []byte(value))
	return buf.String()
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	// SOAP does not require order, but a stable request is easier to debug.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}
