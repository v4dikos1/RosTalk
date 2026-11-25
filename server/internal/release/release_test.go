package release

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSignVerifyRoundTrip(t *testing.T) {
	pub, priv, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	data := []byte("abc123  rostalk-server_1.2.3_linux_amd64\n")
	sig := Sign(priv, data)
	if err := Verify(pub, data, sig); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if err := Verify(pub, append(data, 'x'), sig); err == nil {
		t.Fatal("a modified manifest passed verification")
	}
	otherPub, _, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	if err := Verify(otherPub, data, sig); err == nil {
		t.Fatal("a signature from another key passed verification")
	}
}

func TestParseEncodeSums(t *testing.T) {
	sums := Sums{
		"rostalk-server_1.2.3_linux_amd64": strings.Repeat("a", 64),
		"rostalk-server_1.2.3_linux_arm64": strings.Repeat("b", 64),
	}
	encoded := EncodeSums(sums)
	parsed, err := ParseSums(encoded)
	if err != nil {
		t.Fatalf("ParseSums: %v", err)
	}
	if len(parsed) != 2 || parsed["rostalk-server_1.2.3_linux_arm64"] != strings.Repeat("b", 64) {
		t.Fatalf("unexpected parse result: %#v", parsed)
	}
	// GNU coreutils binary separator and a comment line are accepted.
	parsed, err = ParseSums([]byte("# comment\n" + strings.Repeat("c", 64) + " *file\n"))
	if err != nil || parsed["file"] != strings.Repeat("c", 64) {
		t.Fatalf("ParseSums with binary separator: %v, %#v", err, parsed)
	}
}

func TestParseSumsRejectsUnsafeNames(t *testing.T) {
	for _, line := range []string{
		strings.Repeat("a", 64) + "  ../evil\n",
		strings.Repeat("a", 64) + "  /etc/passwd\n",
		strings.Repeat("a", 64) + "  sub/dir\n",
		"not-a-digest  file\n",
		strings.Repeat("a", 64) + "  file\n" + "broken\n",
	} {
		if _, err := ParseSums([]byte(line)); err == nil {
			t.Fatalf("ParseSums accepted %q", line)
		}
	}
}

func TestVerifyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "asset")
	if err := os.WriteFile(path, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest, err := SumFile(path)
	if err != nil {
		t.Fatalf("SumFile: %v", err)
	}
	if err := VerifyFile(Sums{"asset": digest}, "asset", path); err != nil {
		t.Fatalf("VerifyFile: %v", err)
	}
	if err := VerifyFile(Sums{"asset": strings.Repeat("0", 64)}, "asset", path); err == nil {
		t.Fatal("a wrong digest passed verification")
	}
	if err := VerifyFile(Sums{}, "asset", path); err == nil {
		t.Fatal("an unlisted file passed verification")
	}
}

func TestPickAsset(t *testing.T) {
	sums := Sums{
		"rostalk-server_1.2.3_linux_amd64": strings.Repeat("a", 64),
		"rostalk-server_1.2.3_linux_arm64": strings.Repeat("b", 64),
		"install.sh":                       strings.Repeat("c", 64),
	}
	name, version, err := PickAsset(sums, "arm64")
	if err != nil {
		t.Fatalf("PickAsset: %v", err)
	}
	if name != "rostalk-server_1.2.3_linux_arm64" || version != "1.2.3" {
		t.Fatalf("unexpected asset %q version %q", name, version)
	}
	if _, _, err := PickAsset(sums, "riscv64"); err == nil {
		t.Fatal("PickAsset accepted a missing architecture")
	}
	ambiguous := Sums{
		"rostalk-server_1_linux_amd64": strings.Repeat("a", 64),
		"rostalk-server_2_linux_amd64": strings.Repeat("b", 64),
	}
	if _, _, err := PickAsset(ambiguous, "amd64"); err == nil {
		t.Fatal("PickAsset accepted two binaries for one architecture")
	}
}

func TestKeyPEMRoundTrip(t *testing.T) {
	pub, priv, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	privPEM, err := EncodePrivateKeyPEM(priv)
	if err != nil {
		t.Fatal(err)
	}
	parsedPriv, err := ParsePrivateKeyPEM(privPEM)
	if err != nil {
		t.Fatalf("ParsePrivateKeyPEM: %v", err)
	}
	if !parsedPriv.Equal(priv) {
		t.Fatal("private key changed after the PEM round trip")
	}
	pubPEM, err := EncodePublicKeyPEM(pub)
	if err != nil {
		t.Fatal(err)
	}
	parsedPub, err := ParsePublicKeyPEM(pubPEM)
	if err != nil {
		t.Fatalf("ParsePublicKeyPEM: %v", err)
	}
	if !parsedPub.Equal(pub) {
		t.Fatal("public key changed after the PEM round trip")
	}
	if !parsedPub.Equal(pub) {
		t.Fatal("public key types differ")
	}
}

func TestEmbeddedPublicKey(t *testing.T) {
	original := PublicKeyBase64
	t.Cleanup(func() { PublicKeyBase64 = original })

	PublicKeyBase64 = ""
	if _, err := EmbeddedPublicKey(); err == nil {
		t.Fatal("an empty embedded key was accepted")
	}

	pub, _, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	pemBytes, err := EncodePublicKeyPEM(pub)
	if err != nil {
		t.Fatal(err)
	}
	// same transformation rostalk-sign uses for ldflags
	encoded := strings.Join(strings.Fields(strings.TrimSuffix(
		strings.TrimPrefix(strings.TrimSpace(string(pemBytes)), "-----BEGIN PUBLIC KEY-----"),
		"-----END PUBLIC KEY-----")), "")
	PublicKeyBase64 = encoded
	got, err := EmbeddedPublicKey()
	if err != nil {
		t.Fatalf("EmbeddedPublicKey: %v", err)
	}
	if !got.Equal(pub) {
		t.Fatal("embedded key does not match")
	}
	if len(PublicKeyFingerprint(got)) != 64 {
		t.Fatalf("fingerprint %q is not a sha256 hex", PublicKeyFingerprint(got))
	}
}

// TestDeployKeyMatchesInstaller lives in deploy_key_test.go: it reads files
// that the deployment commit adds.
