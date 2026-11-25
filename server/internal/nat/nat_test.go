package nat

import (
	"context"
	"encoding/binary"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const descriptionXML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
        <deviceList>
          <device>
            <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
            <serviceList>
              <service>
                <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
                <controlURL>/ctl</controlURL>
              </service>
            </serviceList>
          </device>
        </deviceList>
      </device>
    </deviceList>
  </device>
</root>`

func TestUPnPDescriptionAndCalls(t *testing.T) {
	var addBody string
	var deleted bool
	mux := http.NewServeMux()
	mux.HandleFunc("/desc.xml", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/xml")
		_, _ = io.WriteString(w, descriptionXML)
	})
	mux.HandleFunc("/ctl", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case strings.Contains(string(body), "GetExternalIPAddress"):
			_, _ = io.WriteString(w, `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"><NewExternalIPAddress>203.0.113.9</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`)
		case strings.Contains(string(body), "AddPortMapping"):
			addBody = string(body)
			_, _ = io.WriteString(w, `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/></s:Body></s:Envelope>`)
		case strings.Contains(string(body), "DeletePortMapping"):
			deleted = true
			_, _ = io.WriteString(w, `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:DeletePortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/></s:Body></s:Envelope>`)
		default:
			t.Errorf("unexpected SOAP action:\n%s", body)
			http.Error(w, "bad action", http.StatusBadRequest)
		}
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	service, err := fetchDescription(context.Background(), server.URL+"/desc.xml")
	if err != nil {
		t.Fatalf("fetchDescription: %v", err)
	}
	if service.controlURL != server.URL+"/ctl" {
		t.Fatalf("controlURL = %q", service.controlURL)
	}
	ip, err := service.externalIP(context.Background())
	if err != nil {
		t.Fatalf("externalIP: %v", err)
	}
	if ip.String() != "203.0.113.9" {
		t.Fatalf("external IP = %s", ip)
	}

	service.lanIP = "192.0.2.20"
	mapping := Mapping{Protocol: "udp", InternalPort: 7882, ExternalPort: 7882}
	if err := service.addMapping(context.Background(), mapping, time.Hour); err != nil {
		t.Fatalf("addMapping: %v", err)
	}
	for _, want := range []string{
		"<NewInternalClient>192.0.2.20</NewInternalClient>",
		"<NewExternalPort>7882</NewExternalPort>",
		"<NewProtocol>UDP</NewProtocol>",
		"<NewLeaseDuration>3600</NewLeaseDuration>",
	} {
		if !strings.Contains(addBody, want) {
			t.Errorf("AddPortMapping request is missing %s:\n%s", want, addBody)
		}
	}
	if err := service.deleteMapping(context.Background(), mapping); err != nil {
		t.Fatalf("deleteMapping: %v", err)
	}
	if !deleted {
		t.Fatal("DeletePortMapping was not sent")
	}
}

func TestUPnPErrorIsReported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`)
	}))
	defer server.Close()
	service := &upnpService{controlURL: server.URL, serviceType: "urn:schemas-upnp-org:service:WANIPConnection:1", http: server.Client()}
	_, err := service.call(context.Background(), "AddPortMapping", map[string]string{"NewExternalPort": "7443"})
	if err == nil || !strings.Contains(err.Error(), "718") || !strings.Contains(err.Error(), "ConflictInMappingEntry") {
		t.Fatalf("unclear UPnP error: %v", err)
	}
}

func TestPMPExternalAddressAndMapping(t *testing.T) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()

	go func() {
		buf := make([]byte, 32)
		for {
			n, from, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if n < 2 {
				continue
			}
			request := append([]byte(nil), buf[:n]...)
			var response []byte
			switch request[1] {
			case pmpOpExternalAddress:
				response = make([]byte, 12)
				response[1] = pmpOpExternalAddress | 0x80
				copy(response[8:12], net.IPv4(203, 0, 113, 7).To4())
			default:
				response = make([]byte, 16)
				response[1] = request[1] | 0x80
				copy(response[4:8], []byte{0, 0, 0, 1})
				copy(response[8:10], request[4:6])
				copy(response[10:12], request[6:8])
				copy(response[12:16], request[8:12])
			}
			_, _ = conn.WriteToUDP(response, from)
		}
	}()

	client := &pmpClient{addr: conn.LocalAddr().(*net.UDPAddr)}
	ip, err := client.externalAddress(context.Background())
	if err != nil {
		t.Fatalf("externalAddress: %v", err)
	}
	if ip.String() != "203.0.113.7" {
		t.Fatalf("external IP = %s", ip)
	}
	port, err := client.mapPort(context.Background(), Mapping{Protocol: "tcp", InternalPort: 7443, ExternalPort: 7443}, time.Hour)
	if err != nil {
		t.Fatalf("mapPort: %v", err)
	}
	if port != 7443 {
		t.Fatalf("mapped port = %d", port)
	}
	if _, err := client.mapPort(context.Background(), Mapping{Protocol: "udp", InternalPort: 7882, ExternalPort: 7882}, 0); err != nil {
		t.Fatalf("delete mapping: %v", err)
	}
}

func TestPMPRefusal(t *testing.T) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	go func() {
		buf := make([]byte, 32)
		_, from, err := conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		response := make([]byte, 16)
		response[1] = pmpOpExternalAddress | 0x80
		binary.BigEndian.PutUint16(response[2:4], 2)
		_, _ = conn.WriteToUDP(response, from)
	}()
	client := &pmpClient{addr: conn.LocalAddr().(*net.UDPAddr)}
	_, err = client.externalAddress(context.Background())
	if err == nil || !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("unclear NAT-PMP refusal: %v", err)
	}
}

func TestSTUNResponseParsing(t *testing.T) {
	var transactionID [12]byte
	copy(transactionID[:], []byte("abcdefghijkl"))
	mapped := net.IPv4(203, 0, 113, 11).To4()
	port := 54321
	value := make([]byte, 8)
	value[1] = 0x01
	binary.BigEndian.PutUint16(value[2:4], uint16(port)^uint16(stunMagicCookie>>16))
	mask := make([]byte, 4)
	binary.BigEndian.PutUint32(mask, stunMagicCookie)
	for i := 0; i < 4; i++ {
		value[4+i] = mapped[i] ^ mask[i]
	}

	response := make([]byte, 20+4+len(value))
	binary.BigEndian.PutUint16(response[0:2], stunBindingResponse)
	binary.BigEndian.PutUint16(response[2:4], uint16(4+len(value)))
	binary.BigEndian.PutUint32(response[4:8], stunMagicCookie)
	copy(response[8:20], transactionID[:])
	binary.BigEndian.PutUint16(response[20:22], stunAttrXORMapped)
	binary.BigEndian.PutUint16(response[22:24], uint16(len(value)))
	copy(response[24:], value)

	ip, gotPort, err := parseSTUNResponse(response, transactionID)
	if err != nil {
		t.Fatalf("parseSTUNResponse: %v", err)
	}
	if ip.String() != "203.0.113.11" || gotPort != port {
		t.Fatalf("mapped address = %s:%d", ip, gotPort)
	}

	// Another transaction id must be rejected.
	transactionID[0] ^= 0xff
	if _, _, err := parseSTUNResponse(response, transactionID); err == nil {
		t.Fatal("a response with a different transaction id was accepted")
	}
}

func TestForwardOffIsNoop(t *testing.T) {
	session, err := Forward(context.Background(), Options{Mode: "off", LANIP: "192.0.2.2", Mappings: []Mapping{{Protocol: "tcp", InternalPort: 7443, ExternalPort: 7443}}})
	if err != nil || session != nil {
		t.Fatalf("Forward(off) = %v, %v", session, err)
	}
}

func TestForwardRejectsBadOptions(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := Forward(context.Background(), Options{Mode: "carrier-pigeon"}); err == nil {
		t.Fatal("an unknown mode was accepted")
	}
	if _, err := Forward(context.Background(), Options{Mode: "auto", LANIP: "127.0.0.1", Logger: logger, Mappings: []Mapping{{Protocol: "tcp"}}}); err == nil {
		t.Fatal("a loopback LAN address was accepted")
	}
	if _, err := Forward(context.Background(), Options{Mode: "auto", LANIP: "192.0.2.2", Logger: logger}); err == nil {
		t.Fatal("an empty mapping list was accepted")
	}
}
