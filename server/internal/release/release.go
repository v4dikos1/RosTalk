// Package release owns the release artefacts of rostalk-server: SHA256SUMS,
// the Ed25519 signature over that file and the public key every release build
// carries so `rostalk-server update` can verify what it downloads.
//
// Signing is deliberately a separate command (cmd/rostalk-sign) and a separate
// key: the server binary only ever holds the public half. A build without an
// injected public key does not trust any release and says so instead of
// silently accepting an unsigned binary.
package release

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// PublicKeyBase64 is the DER-encoded Ed25519 public key of the release signing
// key, base64 (standard encoding). deploy/release.sh injects it at build time:
//
//	-ldflags "-X .../internal/release.PublicKeyBase64=<value>"
//
// An empty value means the build has no release key (a local developer build);
// Update then refuses to install anything unless --pubkey is given.
var PublicKeyBase64 = ""

// SignatureName is the detached signature file next to SHA256SUMS.
const SignatureName = "SHA256SUMS.sig"

// ChecksumName is the manifest of release artefacts.
const ChecksumName = "SHA256SUMS"

// AssetPattern matches a release binary: rostalk-server_<version>_linux_<arch>.
var AssetPattern = regexp.MustCompile(`^rostalk-server_(.+)_linux_(amd64|arm64)$`)

// ErrNoPublicKey is returned when a build has no embedded release key and the
// caller supplied none.
var ErrNoPublicKey = errors.New("this build carries no release public key")

// EmbeddedPublicKey returns the key injected at build time.
func EmbeddedPublicKey() (ed25519.PublicKey, error) {
	if strings.TrimSpace(PublicKeyBase64) == "" {
		return nil, ErrNoPublicKey
	}
	der, err := base64.StdEncoding.DecodeString(strings.TrimSpace(PublicKeyBase64))
	if err != nil {
		return nil, fmt.Errorf("decode the embedded release key: %w", err)
	}
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse the embedded release key: %w", err)
	}
	pub, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("the embedded release key is not an Ed25519 key")
	}
	return pub, nil
}

// PublicKeyFingerprint is the SHA-256 digest of the public key in lowercase hex.
// It is printed by `rostalk-server version` so two builds can be compared
// without exposing the key itself.
func PublicKeyFingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:])
}

// GenerateKey creates a new Ed25519 key pair.
func GenerateKey() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate an Ed25519 key: %w", err)
	}
	return pub, priv, nil
}

// EncodePrivateKeyPEM wraps a private key as an unencrypted PKCS#8 PEM block.
// The file must stay 0600 and never enter the repository.
func EncodePrivateKeyPEM(priv ed25519.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("marshal the private key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

// ParsePrivateKeyPEM reads an Ed25519 PKCS#8 PEM private key.
func ParsePrivateKeyPEM(data []byte) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, errors.New("the signing key is not a PEM PKCS#8 private key")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse the signing key: %w", err)
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("the signing key is not an Ed25519 key")
	}
	return priv, nil
}

// EncodePublicKeyPEM wraps a public key as a PEM PUBLIC KEY block.
func EncodePublicKeyPEM(pub ed25519.PublicKey) ([]byte, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return nil, fmt.Errorf("marshal the public key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), nil
}

// ParsePublicKeyPEM accepts a PEM PUBLIC KEY block. It is also tolerant of a
// bare base64 DER string, which makes --pubkey easy to paste from the docs.
func ParsePublicKeyPEM(data []byte) (ed25519.PublicKey, error) {
	text := strings.TrimSpace(string(data))
	if strings.HasPrefix(text, "-----BEGIN") {
		block, _ := pem.Decode([]byte(text))
		if block == nil || block.Type != "PUBLIC KEY" {
			return nil, errors.New("the release key is not a PEM PUBLIC KEY")
		}
		return parsePublicKeyDER(block.Bytes)
	}
	der, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return nil, errors.New("the release key is neither PEM nor base64 DER")
	}
	return parsePublicKeyDER(der)
}

// ParsePublicKeyBase64 is the shortcut for the value printed by
// `rostalk-sign pubkey --base64`.
func ParsePublicKeyBase64(value string) (ed25519.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return nil, fmt.Errorf("decode the release key: %w", err)
	}
	return parsePublicKeyDER(der)
}

func parsePublicKeyDER(der []byte) (ed25519.PublicKey, error) {
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse the release key: %w", err)
	}
	pub, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("the release key is not an Ed25519 key")
	}
	return pub, nil
}

// Sign returns the detached signature over data.
func Sign(priv ed25519.PrivateKey, data []byte) []byte {
	return ed25519.Sign(priv, data)
}

// Verify checks a detached signature over data.
func Verify(pub ed25519.PublicKey, data, signature []byte) error {
	if len(pub) != ed25519.PublicKeySize {
		return errors.New("release signature: bad public key size")
	}
	if !ed25519.Verify(pub, data, signature) {
		return errors.New("release signature does not match SHA256SUMS: " +
			"the download is corrupt or was not produced by the RosTalk release key")
	}
	return nil
}

// Sums is a parsed SHA256SUMS file: file name -> lowercase hex digest.
type Sums map[string]string

// EncodeSums renders a SHA256SUMS file in the GNU coreutils format. Names are
// sorted so the file is stable and two builds of the same artefacts match.
func EncodeSums(sums Sums) []byte {
	names := make([]string, 0, len(sums))
	for name := range sums {
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, name := range names {
		fmt.Fprintf(&b, "%s  %s\n", sums[name], name)
	}
	return []byte(b.String())
}

// ParseSums reads a SHA256SUMS file. It accepts both the binary (" *name") and
// text ("  name") separators and rejects malformed digests.
func ParseSums(data []byte) (Sums, error) {
	sums := make(Sums)
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return nil, fmt.Errorf("malformed SHA256SUMS line %q", line)
		}
		if !isHexDigest(fields[0]) {
			return nil, fmt.Errorf("malformed SHA256SUMS digest %q", fields[0])
		}
		name := strings.TrimPrefix(fields[1], "*")
		if name == "" || strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
			return nil, fmt.Errorf("unsafe file name %q in SHA256SUMS", fields[1])
		}
		sums[name] = strings.ToLower(fields[0])
	}
	if len(sums) == 0 {
		return nil, errors.New("SHA256SUMS is empty")
	}
	return sums, nil
}

func isHexDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

// SumFile hashes one file.
func SumFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %q: %w", path, err)
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("hash %q: %w", path, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// VerifyFile compares a file with the digest from SHA256SUMS.
func VerifyFile(sums Sums, name, path string) error {
	want, ok := sums[name]
	if !ok {
		return fmt.Errorf("%s is not listed in SHA256SUMS", name)
	}
	got, err := SumFile(path)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("%s: checksum mismatch (expected %s, got %s)", name, want, got)
	}
	return nil
}

// AssetName is the release file name of one platform.
func AssetName(version, goarch string) string {
	return fmt.Sprintf("rostalk-server_%s_linux_%s", version, goarch)
}

// PickAsset returns the single release binary in sums for arch. It rejects
// files that do not match the release naming scheme, so update never installs
// an arbitrary name chosen by a server.
func PickAsset(sums Sums, goarch string) (string, string, error) {
	var name, version string
	for candidate := range sums {
		match := AssetPattern.FindStringSubmatch(candidate)
		if match == nil || match[2] != goarch {
			continue
		}
		if name != "" {
			return "", "", fmt.Errorf("SHA256SUMS lists more than one binary for linux/%s", goarch)
		}
		name, version = candidate, match[1]
	}
	if name == "" {
		return "", "", fmt.Errorf("SHA256SUMS lists no rostalk-server binary for linux/%s", goarch)
	}
	return name, version, nil
}

// WriteSumsFile writes checksums of the named files from dir to dir/SHA256SUMS.
func WriteSumsFile(dir string, names []string) (Sums, error) {
	sums := make(Sums, len(names))
	for _, name := range names {
		path := filepath.Join(dir, name)
		digest, err := SumFile(path)
		if err != nil {
			return nil, err
		}
		sums[name] = digest
	}
	encoded := EncodeSums(sums)
	if err := os.WriteFile(filepath.Join(dir, ChecksumName), encoded, 0o644); err != nil {
		return nil, fmt.Errorf("write %s: %w", ChecksumName, err)
	}
	return sums, nil
}
