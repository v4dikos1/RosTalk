// Command rostalk-sign creates and verifies RosTalk release signatures.
//
// It is a release tool, not part of the installed server: the private key must
// never be copied to a server. Typical use, once per release:
//
//	rostalk-sign keygen --out rostalk-release.key          # once, keep offline
//	rostalk-sign pubkey --key rostalk-release.key           # publish / commit
//	rostalk-sign sign --key rostalk-release.key SHA256SUMS  # writes SHA256SUMS.sig
//
// Release verification uses:
//
//	rostalk-sign verify --pubkey release.pub SHA256SUMS.sig SHA256SUMS
package main

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/v4dikos1/RosTalk/server/internal/release"
)

const usage = `rostalk-sign — sign and verify RosTalk release artefacts

Usage:
  rostalk-sign keygen --out <private-key.pem> [--force] [--quiet]
  rostalk-sign pubkey --key <private-key.pem> [--base64]
  rostalk-sign sign [--key <private-key.pem>] [-o <signature>] <file>...
  rostalk-sign verify --pubkey <public-key> <signature> <file>

Environment:
  ROSTALK_SIGN_KEY       private key path for "sign" (the --key flag wins)
  ROSTALK_SIGN_PUBKEY    public key for "verify" (the --pubkey flag wins)

The signature is detached Ed25519 over the exact bytes of the file, usually
SHA256SUMS. "sign" with several files signs each one into <file>.sig.
`

func main() {
	if err := execute(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "rostalk-sign: %v\n", err)
		os.Exit(1)
	}
}

func execute(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		_, _ = fmt.Fprint(stderr, usage)
		return errors.New("a subcommand is required (keygen, pubkey, sign, verify)")
	}
	switch args[0] {
	case "keygen":
		return runKeygen(args[1:], stdout, stderr)
	case "pubkey":
		return runPubkey(args[1:], stdout, stderr)
	case "sign":
		return runSign(args[1:], stdout, stderr)
	case "verify":
		return runVerify(args[1:], stdout, stderr)
	case "help", "-h", "--help":
		_, _ = fmt.Fprint(stdout, usage)
		return nil
	default:
		_, _ = fmt.Fprint(stderr, usage)
		return fmt.Errorf("unknown subcommand %q", args[0])
	}
}

func runKeygen(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("keygen", flag.ContinueOnError)
	fs.SetOutput(stderr)
	out := fs.String("out", "", "where to write the private key (required)")
	force := fs.Bool("force", false, "overwrite an existing private key")
	quiet := fs.Bool("quiet", false, "print only the private key path")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *out == "" {
		return errors.New("keygen needs --out")
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if _, err := os.Stat(*out); err == nil && !*force {
		return fmt.Errorf("%s already exists; pass --force to replace it (that invalidates every published release)", *out)
	}

	pub, priv, err := release.GenerateKey()
	if err != nil {
		return err
	}
	pemKey, err := release.EncodePrivateKeyPEM(priv)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, pemKey, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", *out, err)
	}
	if err := os.Chmod(*out, 0o600); err != nil {
		return fmt.Errorf("restrict %s: %w", *out, err)
	}
	pubPEM, err := release.EncodePublicKeyPEM(pub)
	if err != nil {
		return err
	}
	if *quiet {
		_, _ = fmt.Fprintln(stdout, *out)
		return nil
	}
	_, _ = fmt.Fprintf(stdout, `private key: %s (mode 0600, keep it offline — never commit it)
public key:
%s
public key base64: %s
fingerprint: %s

Publish the public key as deploy/release.pub and pass the base64 form to
release.sh as ROSTALK_RELEASE_PUBKEY. Whoever loses the private key cannot
publish updates; a stolen key can sign anything, so store it separately.
`, *out, string(pubPEM), base64OfPublicPEM(pubPEM), release.PublicKeyFingerprint(pub))
	return nil
}

func base64OfPublicPEM(pemBytes []byte) string {
	trimmed := bytes.TrimSpace(pemBytes)
	trimmed = bytes.TrimPrefix(trimmed, []byte("-----BEGIN PUBLIC KEY-----"))
	trimmed = bytes.TrimSuffix(trimmed, []byte("-----END PUBLIC KEY-----"))
	return strings.Join(strings.Fields(string(trimmed)), "")
}

func runPubkey(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("pubkey", flag.ContinueOnError)
	fs.SetOutput(stderr)
	keyPath := fs.String("key", "", "private key path (ROSTALK_SIGN_KEY)")
	asBase64 := fs.Bool("base64", false, "print the base64 DER form used by ldflags")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	path := *keyPath
	if path == "" {
		path = os.Getenv("ROSTALK_SIGN_KEY")
	}
	if path == "" {
		return errors.New("pubkey needs --key or ROSTALK_SIGN_KEY")
	}
	priv, err := loadPrivateKey(path)
	if err != nil {
		return err
	}
	pub := priv.Public().(ed25519.PublicKey)
	pemBytes, err := release.EncodePublicKeyPEM(pub)
	if err != nil {
		return err
	}
	if *asBase64 {
		_, _ = fmt.Fprintln(stdout, base64OfPublicPEM(pemBytes))
		return nil
	}
	_, _ = fmt.Fprintf(stdout, "%s\nfingerprint: %s\n", pemBytes, release.PublicKeyFingerprint(pub))
	return nil
}

func runSign(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("sign", flag.ContinueOnError)
	fs.SetOutput(stderr)
	keyPath := fs.String("key", "", "private key path (ROSTALK_SIGN_KEY)")
	out := fs.String("o", "", "signature path for a single input file (default <file>.sig)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	path := *keyPath
	if path == "" {
		path = os.Getenv("ROSTALK_SIGN_KEY")
	}
	if path == "" {
		return errors.New("sign needs --key or ROSTALK_SIGN_KEY")
	}
	if fs.NArg() == 0 {
		return errors.New("sign needs at least one file")
	}
	if *out != "" && fs.NArg() != 1 {
		return errors.New("-o is only valid with a single input file")
	}
	priv, err := loadPrivateKey(path)
	if err != nil {
		return err
	}
	for _, input := range fs.Args() {
		data, err := os.ReadFile(input)
		if err != nil {
			return fmt.Errorf("read %s: %w", input, err)
		}
		sig := release.Sign(priv, data)
		target := input + ".sig"
		if *out != "" {
			target = *out
		}
		if err := os.WriteFile(target, sig, 0o644); err != nil {
			return fmt.Errorf("write %s: %w", target, err)
		}
		_, _ = fmt.Fprintf(stdout, "%s\n", target)
	}
	return nil
}

func runVerify(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	fs.SetOutput(stderr)
	pubPath := fs.String("pubkey", "", "public key path, PEM or base64 (ROSTALK_SIGN_PUBKEY)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 2 {
		return errors.New("usage: rostalk-sign verify --pubkey <public-key> <signature> <file>")
	}
	path := *pubPath
	if path == "" {
		path = os.Getenv("ROSTALK_SIGN_PUBKEY")
	}
	if path == "" {
		return errors.New("verify needs --pubkey or ROSTALK_SIGN_PUBKEY")
	}
	pubBytes, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read public key %s: %w", path, err)
	}
	pub, err := release.ParsePublicKeyPEM(pubBytes)
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(fs.Arg(0))
	if err != nil {
		return fmt.Errorf("read signature %s: %w", fs.Arg(0), err)
	}
	data, err := os.ReadFile(fs.Arg(1))
	if err != nil {
		return fmt.Errorf("read %s: %w", fs.Arg(1), err)
	}
	if err := release.Verify(pub, data, sig); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "signature OK (%s)\n", release.PublicKeyFingerprint(pub))
	return nil
}

func loadPrivateKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read signing key %s: %w", path, err)
	}
	priv, err := release.ParsePrivateKeyPEM(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return priv, nil
}
