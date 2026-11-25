package client

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

// Identity is the client's Ed25519 key pair: the user's identity on every
// server (design 4.2). The private key never leaves the machine.
type Identity struct {
	Private ed25519.PrivateKey
	Public  ed25519.PublicKey
	Path    string
}

// NewIdentity generates an identity and writes it to path with 0600
// permissions. It fails when the file already exists unless overwrite is true.
func NewIdentity(path string, overwrite bool) (*Identity, error) {
	if path == "" {
		return nil, errors.New("identity path must not be empty")
	}
	if !overwrite {
		if _, err := os.Stat(path); err == nil {
			return nil, fmt.Errorf("identity %q already exists (use --force to overwrite)", path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("stat identity %q: %w", path, err)
		}
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate identity: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create identity directory: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("marshal identity: %w", err)
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return nil, fmt.Errorf("write identity %q: %w", path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("replace identity %q: %w", path, err)
	}
	return &Identity{Private: priv, Public: pub, Path: path}, nil
}

// LoadIdentity reads a PEM PKCS#8 Ed25519 key from path.
func LoadIdentity(path string) (*Identity, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read identity %q: %w", path, err)
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("identity %q is not a PEM PKCS#8 private key", path)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse identity %q: %w", path, err)
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("identity %q is not an Ed25519 key", path)
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("identity %q has an unexpected public key type", path)
	}
	return &Identity{Private: priv, Public: pub, Path: path}, nil
}

// LoadOrCreateIdentity loads the identity at path or creates it.
func LoadOrCreateIdentity(path string) (*Identity, bool, error) {
	if _, err := os.Stat(path); err == nil {
		id, err := LoadIdentity(path)
		return id, false, err
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, fmt.Errorf("stat identity %q: %w", path, err)
	}
	id, err := NewIdentity(path, false)
	return id, true, err
}

// PublicKeyBytes returns the raw 32-byte public key.
func (i *Identity) PublicKeyBytes() []byte { return []byte(i.Public) }

// Fingerprint is the SHA-256 of the public key, in lowercase hex. It identifies
// the user in logs and diagnostics.
func (i *Identity) Fingerprint() string {
	sum := sha256.Sum256(i.Public)
	return hex.EncodeToString(sum[:])
}

// Sign signs msg with the private key.
func (i *Identity) Sign(msg []byte) []byte {
	return ed25519.Sign(i.Private, msg)
}
