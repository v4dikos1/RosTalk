package release

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestDeployKeyMatchesInstaller keeps the three copies of the trust root in
// sync: deploy/release.pub (documentation and release signing), the
// RELEASE_PUBKEY_PEM constant in deploy/install.sh and the fingerprint the
// installer prints. Drift here would make install.sh reject every release
// built by release.sh.
func TestDeployKeyMatchesInstaller(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	pubPEM, err := os.ReadFile(filepath.Join(root, "deploy", "release.pub"))
	if err != nil {
		t.Fatalf("read deploy/release.pub: %v", err)
	}
	pub, err := ParsePublicKeyPEM(pubPEM)
	if err != nil {
		t.Fatalf("deploy/release.pub: %v", err)
	}
	installer, err := os.ReadFile(filepath.Join(root, "deploy", "install.sh"))
	if err != nil {
		t.Fatalf("read deploy/install.sh: %v", err)
	}
	match := regexp.MustCompile(`RELEASE_PUBKEY_PEM='([^']+)'`).FindSubmatch(installer)
	if match == nil {
		t.Fatal("deploy/install.sh has no RELEASE_PUBKEY_PEM")
	}
	embedded, err := ParsePublicKeyBase64(string(match[1]))
	if err != nil {
		t.Fatalf("install.sh RELEASE_PUBKEY_PEM: %v", err)
	}
	if !embedded.Equal(pub) {
		t.Fatal("install.sh embeds a different public key than deploy/release.pub")
	}
	fingerprint := PublicKeyFingerprint(pub)
	if !strings.Contains(string(installer), fingerprint) {
		t.Fatalf("install.sh does not print the release key fingerprint %s", fingerprint)
	}
}
