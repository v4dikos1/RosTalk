// Package netutil owns everything the server needs to speak TLS without a
// domain: a private certificate authority, a leaf certificate signed by it and
// the fingerprints clients pin.
//
// The CA and the leaf are deliberately separate keys and certificates. A
// certificate with IsCA=true used as a server leaf is accepted by Go but
// rejected by rustls/webpki with CaUsedAsEndEntity, so the leaf must never be
// the CA (ADR 0001). The fingerprint in an invite link is the SHA-256 digest of
// the leaf's DER encoding; the client pins it instead of trusting a public CA.
package netutil

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// File names inside the data directory.
const (
	CACertFile     = "ca.crt"
	CAKeyFile      = "ca.key"
	ServerCertFile = "server.crt"
	ServerKeyFile  = "server.key"
)

// validity is long on purpose: rotating the leaf changes the fingerprint and
// invalidates every invite link, so it should only happen on a deliberate
// operator action.
const validity = 10 * 365 * 24 * time.Hour

// TLSMaterial is the loaded server certificate and its CA.
type TLSMaterial struct {
	// Certificate is ready to be used in tls.Config.
	Certificate tls.Certificate
	// GetCertificate, when set, supplies the certificate per handshake. Domain
	// mode uses it so autocert can renew without a restart; Certificate is then
	// empty and CA/Leaf describe only the certificate seen at startup.
	GetCertificate func(*tls.ClientHelloInfo) (*tls.Certificate, error)
	// CA is the parsed authority certificate.
	CA *x509.Certificate
	// CACertPEM is the CA certificate in PEM form, for clients that want to
	// build an explicit trust root instead of pinning the leaf fingerprint.
	CACertPEM []byte
	// Leaf is the parsed server certificate.
	Leaf *x509.Certificate
	// Fingerprint is the SHA-256 digest of the leaf DER encoding.
	Fingerprint [32]byte
	// FingerprintHex is Fingerprint in lowercase hex, the fp= link parameter.
	// Empty in domain mode: clients validate Web PKI instead of pinning.
	FingerprintHex string
	// Dir is the directory the material lives in.
	Dir string
}

// TLSConfig returns a server TLS configuration with the certificate installed.
func (m *TLSMaterial) TLSConfig() *tls.Config {
	cfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		// Only HTTP/1.1: gateway serves plain net/http on a TLS listener, so
		// advertising h2 would negotiate a protocol the server does not speak.
		// acme-tls/1 is required for the Let's Encrypt TLS-ALPN challenge when
		// GetCertificate is autocert's callback.
		NextProtos: []string{"http/1.1", "acme-tls/1"},
	}
	if m.GetCertificate != nil {
		cfg.GetCertificate = m.GetCertificate
		return cfg
	}
	cfg.Certificates = []tls.Certificate{m.Certificate}
	return cfg
}

// CAPool returns a certificate pool containing the CA, matching what a strict
// WebPKI client gets when it is told to trust this server's CA.
func (m *TLSMaterial) CAPool() *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(m.CA)
	return pool
}

// LoadOrCreateTLS loads the CA and leaf from dir, generating whatever is
// missing. Generated material is written with 0600 for keys and 0644 for
// certificates.
//
// hosts are additional names the leaf must cover: the public host, the listen
// address and any address a client may use. localhost, 127.0.0.1 and ::1 are
// always included, because the integration tests and a same-host client use
// them even when the invite link uses a LAN IP.
func LoadOrCreateTLS(dir string, hosts []string) (*TLSMaterial, error) {
	if dir == "" {
		return nil, errors.New("TLS directory must not be empty")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create TLS directory %q: %w", dir, err)
	}

	caCert, caKey, err := loadOrCreateCA(dir)
	if err != nil {
		return nil, err
	}

	leaf, leafKey, err := loadOrCreateLeaf(dir, caCert, caKey, hosts)
	if err != nil {
		return nil, err
	}
	return buildMaterial(dir, caCert, leaf, leafKey)
}

// LoadTLS reads existing CA and leaf material without generating anything. A
// health check must not create a second identity in a data directory that is
// missing or wrong.
func LoadTLS(dir string) (*TLSMaterial, error) {
	caCert, err := loadCertificate(filepath.Join(dir, CACertFile))
	if err != nil {
		return nil, err
	}
	leaf, err := loadCertificate(filepath.Join(dir, ServerCertFile))
	if err != nil {
		return nil, err
	}
	leafKey, err := loadECDSAKey(filepath.Join(dir, ServerKeyFile))
	if err != nil {
		return nil, err
	}
	if pub, ok := leafKey.Public().(*ecdsa.PublicKey); !ok || !pub.Equal(leaf.PublicKey) {
		return nil, fmt.Errorf("key %q does not match certificate %q",
			filepath.Join(dir, ServerKeyFile), filepath.Join(dir, ServerCertFile))
	}
	return buildMaterial(dir, caCert, leaf, leafKey)
}

func buildMaterial(dir string, caCert, leaf *x509.Certificate, leafKey *ecdsa.PrivateKey) (*TLSMaterial, error) {
	der, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		return nil, fmt.Errorf("marshal leaf key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf.Raw})
	tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("build TLS certificate: %w", err)
	}
	tlsCert.Leaf = leaf

	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caCert.Raw})
	return &TLSMaterial{
		Certificate:    tlsCert,
		CA:             caCert,
		CACertPEM:      caPEM,
		Leaf:           leaf,
		Fingerprint:    sha256.Sum256(leaf.Raw),
		FingerprintHex: FingerprintHex(leaf.Raw),
		Dir:            dir,
	}, nil
}

// FingerprintHex returns the lowercase hex SHA-256 digest of a DER certificate.
func FingerprintHex(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

func loadOrCreateCA(dir string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	certPath := filepath.Join(dir, CACertFile)
	keyPath := filepath.Join(dir, CAKeyFile)
	certExists := fileExists(certPath)
	keyExists := fileExists(keyPath)

	switch {
	case certExists && keyExists:
		cert, err := loadCertificate(certPath)
		if err != nil {
			return nil, nil, err
		}
		key, err := loadECDSAKey(keyPath)
		if err != nil {
			return nil, nil, err
		}
		if !cert.IsCA {
			return nil, nil, fmt.Errorf("CA certificate %s is not a CA", certPath)
		}
		if time.Now().Add(24 * time.Hour).After(cert.NotAfter) {
			return nil, nil, fmt.Errorf("CA certificate %s has expired; remove the data directory to create a new one", certPath)
		}
		if err := cert.CheckSignatureFrom(cert); err != nil {
			// Self-signed CA: the signature must verify with its own key.
			return nil, nil, fmt.Errorf("CA certificate %s is corrupt: %w", certPath, err)
		}
		if pub, ok := key.Public().(*ecdsa.PublicKey); !ok || !pub.Equal(cert.PublicKey) {
			return nil, nil, fmt.Errorf("CA key %s does not match %s", keyPath, certPath)
		}
		return cert, key, nil
	case certExists != keyExists:
		return nil, nil, fmt.Errorf("incomplete CA material in %s: both %s and %s are required", dir, CACertFile, CAKeyFile)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate CA key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "RosTalk Local CA", Organization: []string{"RosTalk"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(validity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, fmt.Errorf("create CA certificate: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, fmt.Errorf("parse new CA certificate: %w", err)
	}
	if err := writePEM(certPath, "CERTIFICATE", der, 0o644); err != nil {
		return nil, nil, err
	}
	if err := writeECDSAKey(keyPath, key); err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

func loadOrCreateLeaf(dir string, ca *x509.Certificate, caKey *ecdsa.PrivateKey, hosts []string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	certPath := filepath.Join(dir, ServerCertFile)
	keyPath := filepath.Join(dir, ServerKeyFile)
	certExists := fileExists(certPath)
	keyExists := fileExists(keyPath)

	if certExists && keyExists {
		cert, err := loadCertificate(certPath)
		if err != nil {
			return nil, nil, err
		}
		key, err := loadECDSAKey(keyPath)
		if err != nil {
			return nil, nil, err
		}
		usable := !cert.IsCA &&
			time.Now().Add(24*time.Hour).Before(cert.NotAfter) &&
			cert.CheckSignatureFrom(ca) == nil
		if pub, ok := key.Public().(*ecdsa.PublicKey); !ok || !pub.Equal(cert.PublicKey) {
			usable = false
		}
		if usable {
			return cert, key, nil
		}
		// Keep the CA (and therefore the trust root) but issue a fresh leaf.
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate server key: %w", err)
	}
	serial, err := randomSerial()
	if err != nil {
		return nil, nil, err
	}
	dnsNames, ips := splitHosts(hosts)
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "rostalk-server", Organization: []string{"RosTalk"}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(validity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
		DNSNames:              dnsNames,
		IPAddresses:           ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		return nil, nil, fmt.Errorf("create server certificate: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, fmt.Errorf("parse new server certificate: %w", err)
	}
	if err := writePEM(certPath, "CERTIFICATE", der, 0o644); err != nil {
		return nil, nil, err
	}
	if err := writeECDSAKey(keyPath, key); err != nil {
		return nil, nil, err
	}
	return cert, key, nil
}

func splitHosts(hosts []string) (dnsNames []string, ips []net.IP) {
	seenDNS := map[string]bool{}
	seenIP := map[string]bool{}

	add := func(host string) {
		host = NormalizeHost(host)
		if host == "" {
			return
		}
		if ip := net.ParseIP(host); ip != nil {
			if !seenIP[ip.String()] {
				seenIP[ip.String()] = true
				ips = append(ips, ip)
			}
			return
		}
		lower := strings.ToLower(host)
		if !seenDNS[lower] {
			seenDNS[lower] = true
			dnsNames = append(dnsNames, host)
		}
	}

	for _, host := range append([]string{"localhost", "127.0.0.1", "::1"}, hosts...) {
		add(host)
	}
	for _, ip := range LocalIPs() {
		add(ip)
	}
	sort.Strings(dnsNames)
	return dnsNames, ips
}

// NormalizeHost strips a port and IPv6 brackets from a host string.
func NormalizeHost(host string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.TrimPrefix(strings.TrimSuffix(host, "]"), "[")
	return host
}

// LocalIPs returns the IP addresses of up and running, non-loopback
// interfaces. It is used for certificate SANs and as a fallback for the invite
// link host.
func LocalIPs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
				continue
			}
			out = append(out, ip.String())
		}
	}
	sort.Strings(out)
	return out
}

// DetectLANIP returns the most likely LAN address of the host: the first
// non-loopback IPv4 address. It is only a fallback; production deployments and
// Docker Desktop should pass --public-host explicitly (ADR 0001).
func DetectLANIP() string {
	for _, s := range LocalIPs() {
		if ip := net.ParseIP(s); ip != nil && ip.To4() != nil {
			return s
		}
	}
	return ""
}

func randomSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return nil, fmt.Errorf("generate certificate serial: %w", err)
	}
	return serial, nil
}

func loadCertificate(path string) (*x509.Certificate, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read certificate %q: %w", path, err)
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, fmt.Errorf("certificate %q is not a PEM certificate", path)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse certificate %q: %w", path, err)
	}
	return cert, nil
}

func loadECDSAKey(path string) (*ecdsa.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read key %q: %w", path, err)
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("key %q is not a PEM PKCS#8 private key", path)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse key %q: %w", path, err)
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("key %q is not an ECDSA key", path)
	}
	return key, nil
}

func writeECDSAKey(path string, key *ecdsa.PrivateKey) error {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return fmt.Errorf("marshal key %q: %w", path, err)
	}
	return writePEM(path, "PRIVATE KEY", der, 0o600)
}

func writePEM(path, blockType string, der []byte, mode os.FileMode) error {
	data := pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return fmt.Errorf("write %q: %w", path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace %q: %w", path, err)
	}
	return nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
