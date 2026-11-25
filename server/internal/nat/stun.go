package nat

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"time"
)

// STUN (RFC 5389) is a tiny binary protocol; this is the subset doctor needs:
// ask a public server which address and port it sees, which proves UDP egress
// and often reveals the public IP even when the router has no UPnP.
const (
	stunBindingRequest  = 0x0001
	stunBindingResponse = 0x0101
	stunMagicCookie     = 0x2112A442
	stunAttrMapped      = 0x0001
	stunAttrXORMapped   = 0x0020
)

// STUNExternalIP sends one binding request to server (host:port) and returns
// the mapped address.
func STUNExternalIP(ctx context.Context, server string) (net.IP, int, error) {
	addr, err := net.ResolveUDPAddr("udp4", server)
	if err != nil {
		return nil, 0, fmt.Errorf("STUN: resolve %s: %w", server, err)
	}
	conn, err := net.DialUDP("udp4", nil, addr)
	if err != nil {
		return nil, 0, fmt.Errorf("STUN: dial %s: %w", server, err)
	}
	defer func() { _ = conn.Close() }()

	deadline := time.Now().Add(3 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetDeadline(deadline)

	request, transactionID, err := newSTUNRequest()
	if err != nil {
		return nil, 0, err
	}
	if _, err := conn.Write(request); err != nil {
		return nil, 0, fmt.Errorf("STUN: send: %w", err)
	}
	buf := make([]byte, 1500)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, 0, fmt.Errorf("STUN: no answer from %s: %w", server, err)
	}
	return parseSTUNResponse(buf[:n], transactionID)
}

func newSTUNRequest() ([]byte, [12]byte, error) {
	var transactionID [12]byte
	if _, err := rand.Read(transactionID[:]); err != nil {
		return nil, transactionID, fmt.Errorf("STUN: transaction id: %w", err)
	}
	request := make([]byte, 20)
	binary.BigEndian.PutUint16(request[0:2], stunBindingRequest)
	binary.BigEndian.PutUint16(request[2:4], 0)
	binary.BigEndian.PutUint32(request[4:8], stunMagicCookie)
	copy(request[8:20], transactionID[:])
	return request, transactionID, nil
}

func parseSTUNResponse(data []byte, transactionID [12]byte) (net.IP, int, error) {
	if len(data) < 20 {
		return nil, 0, errors.New("STUN: short response")
	}
	if binary.BigEndian.Uint16(data[0:2]) != stunBindingResponse {
		return nil, 0, errors.New("STUN: not a binding response")
	}
	if binary.BigEndian.Uint32(data[4:8]) != stunMagicCookie {
		return nil, 0, errors.New("STUN: wrong magic cookie")
	}
	if string(data[8:20]) != string(transactionID[:]) {
		return nil, 0, errors.New("STUN: transaction id mismatch")
	}
	length := int(binary.BigEndian.Uint16(data[2:4]))
	if length > len(data)-20 {
		return nil, 0, errors.New("STUN: truncated attributes")
	}
	attributes := data[20 : 20+length]
	for len(attributes) >= 4 {
		attrType := binary.BigEndian.Uint16(attributes[0:2])
		attrLen := int(binary.BigEndian.Uint16(attributes[2:4]))
		if attrLen > len(attributes)-4 {
			return nil, 0, errors.New("STUN: malformed attribute")
		}
		value := attributes[4 : 4+attrLen]
		if ip, port, ok := decodeSTUNAddress(attrType, value, transactionID); ok {
			return ip, port, nil
		}
		padded := (attrLen + 3) &^ 3
		if padded+4 > len(attributes) {
			break
		}
		attributes = attributes[4+padded:]
	}
	return nil, 0, errors.New("STUN: the response has no mapped address")
}

func decodeSTUNAddress(attrType uint16, value []byte, transactionID [12]byte) (net.IP, int, bool) {
	if attrType != stunAttrXORMapped && attrType != stunAttrMapped {
		return nil, 0, false
	}
	if len(value) < 4 {
		return nil, 0, false
	}
	family := value[1]
	port := int(binary.BigEndian.Uint16(value[2:4]))
	var ip net.IP
	switch family {
	case 0x01:
		if len(value) < 8 {
			return nil, 0, false
		}
		ip = make(net.IP, 4)
		copy(ip, value[4:8])
	case 0x02:
		if len(value) < 20 {
			return nil, 0, false
		}
		ip = make(net.IP, 16)
		copy(ip, value[4:20])
	default:
		return nil, 0, false
	}
	if attrType == stunAttrXORMapped {
		port ^= stunMagicCookie >> 16
		mask := make([]byte, 16)
		binary.BigEndian.PutUint32(mask[0:4], stunMagicCookie)
		copy(mask[4:], transactionID[:])
		for i := range ip {
			ip[i] ^= mask[i]
		}
	}
	return ip, port, true
}
