package integration

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	rostalkv1 "github.com/v4dikos1/RosTalk/proto/gen/go/rostalk/v1"
)

// testIdentity is an Ed25519 key pair used by a test client.
type testIdentity struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

func newTestIdentity() (*testIdentity, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &testIdentity{priv: priv, pub: pub}, nil
}

type serverError struct {
	code      rostalkv1.ErrorCode
	message   string
	retryable bool
}

func (e *serverError) Error() string {
	return fmt.Sprintf("%s: %s", e.code.String(), e.message)
}

type testSession struct {
	conn     *websocket.Conn
	welcome  *rostalkv1.Welcome
	serverID []byte
}

func (s *testSession) close() {
	_ = s.conn.CloseNow()
}

func (s *testSession) next(ctx context.Context) (*rostalkv1.ServerFrame, error) {
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

type connectOptions struct {
	identity        *testIdentity
	nickname        string
	invite          string
	password        string
	fingerprint     string
	roots           *x509.CertPool
	badSignature    bool
	protocolVersion uint32
}

// testConnect dials the server, pins (or chain-verifies) TLS and runs the
// handshake. A server Error frame is returned as *serverError.
func testConnect(ctx context.Context, addr string, opts connectOptions) (*testSession, error) {
	if opts.identity == nil {
		return nil, errors.New("identity is required")
	}
	if opts.protocolVersion == 0 {
		opts.protocolVersion = 1
	}

	tlsConfig := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true,
		NextProtos:         []string{"http/1.1"},
	}
	if opts.roots != nil {
		tlsConfig.RootCAs = opts.roots
		tlsConfig.ServerName = hostOnly(addr)
		tlsConfig.InsecureSkipVerify = false
	} else {
		expected, err := hex.DecodeString(opts.fingerprint)
		if err != nil || len(expected) != sha256.Size {
			return nil, fmt.Errorf("bad fingerprint %q", opts.fingerprint)
		}
		tlsConfig.VerifyConnection = func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("no server certificate")
			}
			got := sha256.Sum256(state.PeerCertificates[0].Raw)
			if !bytesEqual(got[:], expected) {
				return fmt.Errorf("certificate fingerprint mismatch: want %s got %s",
					opts.fingerprint, hex.EncodeToString(got[:]))
			}
			return nil
		}
	}

	httpClient := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig}}
	conn, resp, err := websocket.Dial(ctx, "wss://"+addr+"/ws", &websocket.DialOptions{
		HTTPClient:      httpClient,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("dial: %w (HTTP %s)", err, resp.Status)
		}
		return nil, fmt.Errorf("dial: %w", err)
	}
	conn.SetReadLimit(1 << 20)

	if err := writeClientFrame(ctx, conn, &rostalkv1.ClientFrame{
		RequestId: 1,
		Payload: &rostalkv1.ClientFrame_Hello{Hello: &rostalkv1.Hello{
			ProtocolVersion: opts.protocolVersion,
			ClientVersion:   "integration-test",
			PublicKey:       opts.identity.pub,
			Nickname:        opts.nickname,
			Invite:          opts.invite,
			Password:        opts.password,
		}},
	}); err != nil {
		_ = conn.CloseNow()
		return nil, err
	}

	frame, err := readServerFrame(ctx, conn)
	if err != nil {
		_ = conn.CloseNow()
		return nil, err
	}
	if serverErr := frame.GetError(); serverErr != nil {
		_ = conn.CloseNow()
		return nil, toServerError(serverErr)
	}
	if frame.GetReplyTo() != 1 || frame.GetChallenge() == nil {
		_ = conn.CloseNow()
		return nil, fmt.Errorf("expected Challenge with reply_to 1, got %T reply_to %d",
			frame.GetPayload(), frame.GetReplyTo())
	}
	challenge := frame.GetChallenge()

	signature := make([]byte, ed25519.SignatureSize)
	if opts.badSignature {
		if _, err := rand.Read(signature); err != nil {
			_ = conn.CloseNow()
			return nil, err
		}
	} else {
		signed := append(append([]byte(nil), challenge.GetNonce()...), challenge.GetServerId()...)
		signature = ed25519.Sign(opts.identity.priv, signed)
	}

	if err := writeClientFrame(ctx, conn, &rostalkv1.ClientFrame{
		RequestId: 2,
		Payload: &rostalkv1.ClientFrame_Authenticate{Authenticate: &rostalkv1.Authenticate{
			Signature: signature,
		}},
	}); err != nil {
		_ = conn.CloseNow()
		return nil, err
	}

	frame, err = readServerFrame(ctx, conn)
	if err != nil {
		_ = conn.CloseNow()
		return nil, err
	}
	if serverErr := frame.GetError(); serverErr != nil {
		_ = conn.CloseNow()
		return nil, toServerError(serverErr)
	}
	if frame.GetReplyTo() != 2 || frame.GetWelcome() == nil {
		_ = conn.CloseNow()
		return nil, fmt.Errorf("expected Welcome with reply_to 2, got %T reply_to %d",
			frame.GetPayload(), frame.GetReplyTo())
	}
	return &testSession{
		conn:     conn,
		welcome:  frame.GetWelcome(),
		serverID: append([]byte(nil), challenge.GetServerId()...),
	}, nil
}

func writeClientFrame(ctx context.Context, conn *websocket.Conn, frame *rostalkv1.ClientFrame) error {
	data, err := proto.Marshal(frame)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageBinary, data)
}

func readServerFrame(ctx context.Context, conn *websocket.Conn) (*rostalkv1.ServerFrame, error) {
	typ, data, err := conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, fmt.Errorf("expected a binary frame, got %v", typ)
	}
	frame := &rostalkv1.ServerFrame{}
	if err := proto.Unmarshal(data, frame); err != nil {
		return nil, err
	}
	return frame, nil
}

func toServerError(err *rostalkv1.Error) *serverError {
	return &serverError{code: err.GetCode(), message: err.GetMessage(), retryable: err.GetRetryable()}
}

func asServerError(err error) (*serverError, bool) {
	var serverErr *serverError
	if errors.As(err, &serverErr) {
		return serverErr, true
	}
	return nil, false
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

func hostOnly(addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

func waitFrame(t *testing.T, session *testSession) *rostalkv1.ServerFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	frame, err := session.next(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return frame
}
