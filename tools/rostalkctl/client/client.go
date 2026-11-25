package client

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"
)

// ProtocolVersion is the wire protocol version this client speaks.
const ProtocolVersion uint32 = 1

// Options tunes a connection.
type Options struct {
	// Nickname is the desired display name. May be empty for a known key.
	Nickname string
	// Password is the server password for LOGIN_MODE_PASSWORD servers.
	Password string
	// ClientVersion is reported to the server for diagnostics only.
	ClientVersion string
	// RootCAs, when set, makes the client verify the full TLS chain in addition
	// to pinning the leaf fingerprint from the link. Tests use the server's
	// ca.crt; the CLI accepts --ca.
	RootCAs *x509.CertPool
	// Timeout bounds the TCP/TLS/WebSocket handshake. Defaults to 15 seconds.
	Timeout time.Duration
}

// ServerError is an Error frame returned by the server.
type ServerError struct {
	Code      rostalkv1.ErrorCode
	Message   string
	Retryable bool
	ActionURL string
}

func (e *ServerError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code.String(), e.Message)
}

// Session is an authenticated control-plane connection.
type Session struct {
	conn     *websocket.Conn
	Link     Link
	Welcome  *rostalkv1.Welcome
	ServerID []byte
}

// Connect opens the WebSocket, pins the TLS leaf fingerprint and performs the
// Ed25519 handshake. On success the returned session is ready for Next.
func Connect(ctx context.Context, link Link, id *Identity, opts Options) (*Session, error) {
	if id == nil {
		return nil, errors.New("identity is required")
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 15 * time.Second
	}
	dialCtx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()

	tlsConfig, err := tlsConfigFor(link, opts.RootCAs)
	if err != nil {
		return nil, err
	}
	httpClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
	}
	conn, resp, err := websocket.Dial(dialCtx, link.WSURL(), &websocket.DialOptions{
		HTTPClient:      httpClient,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("connect to %s: %w (HTTP %s)", link.Host, err, resp.Status)
		}
		return nil, fmt.Errorf("connect to %s: %w", link.Host, err)
	}
	conn.SetReadLimit(1 << 20)

	clientVersion := opts.ClientVersion
	if clientVersion == "" {
		clientVersion = "rostalkctl"
	}

	if err := writeFrame(dialCtx, conn, &rostalkv1.ClientFrame{
		RequestId: 1,
		Payload: &rostalkv1.ClientFrame_Hello{Hello: &rostalkv1.Hello{
			ProtocolVersion: ProtocolVersion,
			ClientVersion:   clientVersion,
			PublicKey:       id.PublicKeyBytes(),
			Nickname:        opts.Nickname,
			Invite:          link.Invite,
			Password:        opts.Password,
		}},
	}); err != nil {
		_ = conn.CloseNow()
		return nil, err
	}

	challenge, err := readChallenge(dialCtx, conn, 1)
	if err != nil {
		_ = conn.CloseNow()
		return nil, err
	}
	if len(challenge.GetNonce()) < 32 {
		_ = conn.CloseNow()
		return nil, fmt.Errorf("server sent a short nonce (%d bytes)", len(challenge.GetNonce()))
	}
	if len(challenge.GetServerId()) != sha256.Size {
		_ = conn.CloseNow()
		return nil, fmt.Errorf("server sent a malformed server id (%d bytes)", len(challenge.GetServerId()))
	}

	signed := make([]byte, 0, len(challenge.GetNonce())+len(challenge.GetServerId()))
	signed = append(signed, challenge.GetNonce()...)
	signed = append(signed, challenge.GetServerId()...)

	if err := writeFrame(dialCtx, conn, &rostalkv1.ClientFrame{
		RequestId: 2,
		Payload: &rostalkv1.ClientFrame_Authenticate{Authenticate: &rostalkv1.Authenticate{
			Signature: id.Sign(signed),
		}},
	}); err != nil {
		_ = conn.CloseNow()
		return nil, err
	}

	welcome, err := readWelcome(dialCtx, conn, 2)
	if err != nil {
		_ = conn.CloseNow()
		return nil, err
	}
	if serverID := welcome.GetSnapshot().GetServer().GetId(); len(serverID) > 0 {
		if !bytesEqual(serverID, challenge.GetServerId()) {
			_ = conn.CloseNow()
			return nil, errors.New("server id in Welcome does not match Challenge.server_id")
		}
	}

	return &Session{
		conn:     conn,
		Link:     link,
		Welcome:  welcome,
		ServerID: append([]byte(nil), challenge.GetServerId()...),
	}, nil
}

// Send writes one client frame. The caller owns request_id numbering.
func (s *Session) Send(ctx context.Context, frame *rostalkv1.ClientFrame) error {
	return writeFrame(ctx, s.conn, frame)
}

// Next returns the next server frame (an event or a reply).
func (s *Session) Next(ctx context.Context) (*rostalkv1.ServerFrame, error) {
	typ, data, err := s.conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, fmt.Errorf("expected a binary frame, got %v", typ)
	}
	frame := &rostalkv1.ServerFrame{}
	if err := proto.Unmarshal(data, frame); err != nil {
		return nil, fmt.Errorf("decode ServerFrame: %w", err)
	}
	return frame, nil
}

// Close closes the WebSocket without waiting for a close handshake.
func (s *Session) Close() error {
	return s.conn.CloseNow()
}

func tlsConfigFor(link Link, roots *x509.CertPool) (*tls.Config, error) {
	expected, err := hex.DecodeString(link.Fingerprint)
	if err != nil || len(expected) != sha256.Size {
		return nil, fmt.Errorf("invalid certificate fingerprint %q", link.Fingerprint)
	}
	return &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // verification is done below against the pinned fingerprint
		NextProtos:         []string{"http/1.1"},
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("server presented no certificate")
			}
			leaf := state.PeerCertificates[0]
			got := sha256.Sum256(leaf.Raw)
			if !bytesEqual(got[:], expected) {
				return fmt.Errorf("certificate fingerprint mismatch: link expects %s, server presented %s",
					link.Fingerprint, hex.EncodeToString(got[:]))
			}
			now := time.Now()
			if now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
				return fmt.Errorf("server certificate is not valid now (not before %s, not after %s)",
					leaf.NotBefore.Format(time.RFC3339), leaf.NotAfter.Format(time.RFC3339))
			}
			if roots == nil {
				// Pinned mode: the fingerprint is the identity, no hostname
				// check is possible or needed.
				return nil
			}
			intermediates := x509.NewCertPool()
			for _, cert := range state.PeerCertificates[1:] {
				intermediates.AddCert(cert)
			}
			if _, err := leaf.Verify(x509.VerifyOptions{
				Roots:         roots,
				Intermediates: intermediates,
				DNSName:       link.Hostname(),
				KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			}); err != nil {
				return fmt.Errorf("verify server certificate chain: %w", err)
			}
			return nil
		},
	}, nil
}

func writeFrame(ctx context.Context, conn *websocket.Conn, frame *rostalkv1.ClientFrame) error {
	data, err := proto.Marshal(frame)
	if err != nil {
		return fmt.Errorf("encode ClientFrame: %w", err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, data); err != nil {
		return fmt.Errorf("send frame: %w", err)
	}
	return nil
}

func readFrame(ctx context.Context, conn *websocket.Conn) (*rostalkv1.ServerFrame, error) {
	typ, data, err := conn.Read(ctx)
	if err != nil {
		return nil, fmt.Errorf("read frame: %w", err)
	}
	if typ != websocket.MessageBinary {
		return nil, fmt.Errorf("expected a binary frame, got %v", typ)
	}
	frame := &rostalkv1.ServerFrame{}
	if err := proto.Unmarshal(data, frame); err != nil {
		return nil, fmt.Errorf("decode ServerFrame: %w", err)
	}
	return frame, nil
}

func readChallenge(ctx context.Context, conn *websocket.Conn, replyTo uint64) (*rostalkv1.Challenge, error) {
	frame, err := readFrame(ctx, conn)
	if err != nil {
		return nil, err
	}
	if serverErr := frame.GetError(); serverErr != nil {
		return nil, serverError(serverErr)
	}
	if frame.GetReplyTo() != replyTo {
		return nil, fmt.Errorf("unexpected reply_to %d, want %d", frame.GetReplyTo(), replyTo)
	}
	challenge := frame.GetChallenge()
	if challenge == nil {
		return nil, errors.New("server did not answer Hello with Challenge")
	}
	return challenge, nil
}

func readWelcome(ctx context.Context, conn *websocket.Conn, replyTo uint64) (*rostalkv1.Welcome, error) {
	frame, err := readFrame(ctx, conn)
	if err != nil {
		return nil, err
	}
	if serverErr := frame.GetError(); serverErr != nil {
		return nil, serverError(serverErr)
	}
	if frame.GetReplyTo() != replyTo {
		return nil, fmt.Errorf("unexpected reply_to %d, want %d", frame.GetReplyTo(), replyTo)
	}
	welcome := frame.GetWelcome()
	if welcome == nil {
		return nil, errors.New("server did not answer Authenticate with Welcome")
	}
	return welcome, nil
}

func serverError(err *rostalkv1.Error) *ServerError {
	return &ServerError{
		Code:      err.GetCode(),
		Message:   err.GetMessage(),
		Retryable: err.GetRetryable(),
		ActionURL: err.GetActionUrl(),
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// IsServerError reports whether err is a ServerError with the given code.
func IsServerError(err error, code rostalkv1.ErrorCode) bool {
	var serverErr *ServerError
	if !errors.As(err, &serverErr) {
		return false
	}
	return serverErr.Code == code
}

// LoadRootCAs parses a PEM bundle into a certificate pool.
func LoadRootCAs(pemData []byte) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemData) {
		return nil, errors.New("no certificates found in the CA bundle")
	}
	return pool, nil
}

// NormalizeFingerprint lowercases and trims whitespace around a fingerprint.
func NormalizeFingerprint(fp string) string {
	return strings.ToLower(strings.TrimSpace(fp))
}
