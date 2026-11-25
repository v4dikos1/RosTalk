// Package update implements `rostalk-server update`: download SHA256SUMS and its
// Ed25519 signature, check the signature, download the binary for this
// architecture, check its checksum and replace the running executable.
//
// There is no unsigned path. A build without an embedded release key only works
// when the operator passes --pubkey explicitly.
package update

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/v4dikos1/RosTalk/server/internal/release"
)

// maxAssetSize bounds one downloaded binary.
const maxAssetSize = 256 << 20 // 256 MiB

// Client is one update source.
type Client struct {
	// BaseURL is the directory that holds SHA256SUMS, SHA256SUMS.sig and the
	// binaries (for example https://example.net/rostalk/).
	BaseURL string
	// PublicKey verifies SHA256SUMS. Required.
	PublicKey ed25519.PublicKey
	// CurrentVersion is printed in reports and used by Check.
	CurrentVersion string
	// GOOS and GOARCH default to the running platform (linux/amd64 here).
	GOOS   string
	GOARCH string
	// HTTP is injectable for tests; nil means a client with a 60s timeout.
	HTTP *http.Client
	// Validate runs the downloaded file before it replaces the target. Nil
	// means the real smoke test (`<binary> version`); tests inject a no-op.
	Validate func(path string) error
}

// Release describes the remote release.
type Release struct {
	Version   string
	AssetName string
}

// Check fetches and verifies the manifest without downloading the binary.
func (c *Client) Check(ctx context.Context) (Release, error) {
	sums, err := c.fetchSums(ctx)
	if err != nil {
		return Release{}, err
	}
	name, remoteVersion, err := release.PickAsset(sums, c.arch())
	if err != nil {
		return Release{}, err
	}
	return Release{Version: remoteVersion, AssetName: name}, nil
}

// Apply downloads the release binary, verifies it, runs `version` on it and
// atomically replaces target.
func (c *Client) Apply(ctx context.Context, target string) (Release, error) {
	if target == "" {
		return Release{}, errors.New("update: the target binary path is empty")
	}
	sums, err := c.fetchSums(ctx)
	if err != nil {
		return Release{}, err
	}
	name, remoteVersion, err := release.PickAsset(sums, c.arch())
	if err != nil {
		return Release{}, err
	}
	if remoteVersion == c.CurrentVersion {
		return Release{Version: remoteVersion, AssetName: name}, nil
	}

	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return Release{}, fmt.Errorf("update: resolve %q: %w", target, err)
	}
	dir := filepath.Dir(targetAbs)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(targetAbs)+".new-*")
	if err != nil {
		return Release{}, fmt.Errorf("update: cannot write next to %q (run as root?): %w", targetAbs, err)
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	downloadURL, err := c.assetURL(name)
	if err != nil {
		return Release{}, err
	}
	if err := c.download(ctx, downloadURL, tmp); err != nil {
		return Release{}, err
	}
	if err := tmp.Close(); err != nil {
		return Release{}, fmt.Errorf("update: write %q: %w", tmpName, err)
	}
	if err := release.VerifyFile(sums, name, tmpName); err != nil {
		return Release{}, fmt.Errorf("update: %w", err)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return Release{}, fmt.Errorf("update: make %q executable: %w", tmpName, err)
	}
	validate := c.Validate
	if validate == nil {
		validate = smokeTest
	}
	if err := validate(tmpName); err != nil {
		return Release{}, err
	}
	if err := os.Rename(tmpName, targetAbs); err != nil {
		return Release{}, fmt.Errorf("update: replace %q: %w", targetAbs, err)
	}
	cleanup = false
	return Release{Version: remoteVersion, AssetName: name}, nil
}

// fetchSums downloads and verifies SHA256SUMS.
func (c *Client) fetchSums(ctx context.Context) (release.Sums, error) {
	if len(c.PublicKey) != ed25519.PublicKeySize {
		return nil, release.ErrNoPublicKey
	}
	sumsURL, err := c.join(release.ChecksumName)
	if err != nil {
		return nil, err
	}
	sigURL, err := c.join(release.SignatureName)
	if err != nil {
		return nil, err
	}
	sumsData, err := c.fetch(ctx, sumsURL, 1<<20)
	if err != nil {
		return nil, fmt.Errorf("update: %w", err)
	}
	sig, err := c.fetch(ctx, sigURL, 64)
	if err != nil {
		return nil, fmt.Errorf("update: %w", err)
	}
	if err := release.Verify(c.PublicKey, sumsData, sig); err != nil {
		return nil, err
	}
	return release.ParseSums(sumsData)
}

func (c *Client) download(ctx context.Context, source string, dest *os.File) error {
	client := c.httpClient()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("update: download %s: %w", source, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("update: download %s: %s", source, resp.Status)
	}
	written, err := io.Copy(dest, io.LimitReader(resp.Body, maxAssetSize+1))
	if err != nil {
		return fmt.Errorf("update: download %s: %w", source, err)
	}
	if written > maxAssetSize {
		return fmt.Errorf("update: %s is larger than the %d byte limit", source, maxAssetSize)
	}
	return nil
}

func (c *Client) fetch(ctx context.Context, source string, limit int64) ([]byte, error) {
	client := c.httpClient()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", source, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: %s", source, resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", source, err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("download %s: response is larger than %d bytes", source, limit)
	}
	return data, nil
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func (c *Client) arch() string {
	if c.GOARCH != "" {
		return c.GOARCH
	}
	return runtime.GOARCH
}

func (c *Client) assetURL(name string) (string, error) {
	if c.GOOS != "" && c.GOOS != "linux" {
		return "", fmt.Errorf("update: rostalk-server runs only on Linux (this is %s)", c.GOOS)
	}
	return c.join(name)
}

func (c *Client) join(name string) (string, error) {
	base := strings.TrimSuffix(strings.TrimSpace(c.BaseURL), "/")
	if base == "" {
		return "", errors.New("update: --release-url is required")
	}
	u, err := url.Parse(base + "/" + name)
	if err != nil {
		return "", fmt.Errorf("update: invalid release URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("update: release URL must be http or https, got %q", u.Scheme)
	}
	return u.String(), nil
}

// smokeTest makes sure the downloaded file is an executable of this server
// before it replaces a working binary.
func smokeTest(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("update: the downloaded binary did not run (%w): %s", err, strings.TrimSpace(string(out)))
	}
	if !strings.HasPrefix(strings.TrimSpace(string(out)), "rostalk-server ") {
		return fmt.Errorf("update: the downloaded file is not rostalk-server: %q", strings.TrimSpace(string(out)))
	}
	return nil
}
