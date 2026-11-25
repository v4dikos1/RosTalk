// Package identity owns the server's long-lived Ed25519 key. Its SHA-256
// fingerprint is the server id that clients sign during the handshake, so the
// login does not depend on the TLS certificate (design 4.2, ADR 0004).
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// FileName is the key file inside the data directory.
const FileName = "identity.key"

// Identity is the server's long-lived Ed25519 key pair.
type Identity struct {
	Private ed25519.PrivateKey
	Public  ed25519.PublicKey
	// ID is the SHA-256 fingerprint of Public; it is Challenge.server_id and
	// ServerSnapshot.server.id.
	ID [32]byte
}

// LoadOrCreate loads the key from dir or generates it on first start. The key
// survives restarts, so the server id and every client's cached trust stay
// stable.
func LoadOrCreate(dir string) (*Identity, error) {
	if dir == "" {
		return nil, errors.New("identity directory must not be empty")
	}
	path := filepath.Join(dir, FileName)

	data, err := os.ReadFile(path)
	if err == nil {
		return parse(path, data)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read identity key %q: %w", path, err)
	}

	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create identity directory %q: %w", dir, err)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate server identity: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("marshal server identity: %w", err)
	}
	pemData := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if err := writeAtomic(path, pemData, 0o600); err != nil {
		return nil, err
	}
	return newIdentity(priv, pub), nil
}

// Generate creates an in-memory identity without touching the disk. Tests and
// `rostalkctl identity new` use it.
func Generate() (*Identity, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate Ed25519 key: %w", err)
	}
	return newIdentity(priv, pub), nil
}

// IDFingerprintHex returns the server id as lowercase hex.
func (i *Identity) IDFingerprintHex() string {
	return hex.EncodeToString(i.ID[:])
}

func newIdentity(priv ed25519.PrivateKey, pub ed25519.PublicKey) *Identity {
	return &Identity{
		Private: priv,
		Public:  pub,
		ID:      sha256.Sum256(pub),
	}
}

func parse(path string, data []byte) (*Identity, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("identity key %q is not a PEM PKCS#8 private key", path)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse identity key %q: %w", path, err)
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("identity key %q is not an Ed25519 key", path)
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("identity key %q has an unexpected public key type", path)
	}
	return newIdentity(priv, pub), nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
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
