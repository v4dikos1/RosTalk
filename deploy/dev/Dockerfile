# syntax=docker/dockerfile:1

# rostalk-server, built from the sources in server/.
# Build context is the repository root:
#   docker build -f deploy/dev/Dockerfile .
#   docker build -f deploy/dev/Dockerfile --target test .   # Go tests with -race

FROM golang:1.27 AS build

WORKDIR /src

# Copy the module files first so the dependency download layer stays cached
# while the code is being changed. Updating livekit-server invalidates it on
# purpose: its Pion forks are pinned with replace directives (ADR 0001).
#
# server/ imports the generated protocol module through a local replace, so the
# replacement's go.mod has to be present before `go mod download`.
COPY server/go.mod server/go.sum ./server/
COPY proto/gen/go/go.mod proto/gen/go/go.sum ./proto/gen/go/
COPY tools/rostalkctl/go.mod tools/rostalkctl/go.sum ./tools/rostalkctl/
RUN --mount=type=cache,target=/go/pkg/mod \
    cd server && go mod download
RUN --mount=type=cache,target=/go/pkg/mod \
    cd tools/rostalkctl && go mod download

COPY proto/gen/go ./proto/gen/go
COPY tools/rostalkctl ./tools/rostalkctl
COPY server/ ./server/

# Not needed to build the binary, but internal/release checks that install.sh
# embeds the key from release.pub; the Linux test image must see both.
COPY deploy/release.pub deploy/install.sh ./deploy/

# server/ and the generated protocol are separate Go modules (ADR 0001).
# The Pion replaces for the embedded LiveKit are already in server/go.mod.

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILT_AT=unknown

# CGO is disabled: the server is a static single binary (design 2) and the
# embedded LiveKit builds without cgo (ADR 0001).
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd server && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath \
        -ldflags="-s -w \
          -X github.com/v4dikos1/RosTalk/server/internal/version.Version=${VERSION} \
          -X github.com/v4dikos1/RosTalk/server/internal/version.Commit=${COMMIT} \
          -X github.com/v4dikos1/RosTalk/server/internal/version.Date=${BUILT_AT}" \
        -o /out/rostalk-server ./cmd/rostalk-server

# Test stage: same sources with the Go toolchain and cgo enabled, because the
# race detector needs cgo. Used by `make test-server-docker`, so Windows hosts
# run the Linux test suite without installing Go or WSL. The rostalkctl suite
# includes the end-to-end test that builds this server and connects a client.
FROM build AS test
ENV CGO_ENABLED=1
CMD ["sh", "-c", "cd /src/server && go test ./... -race && cd /src/tools/rostalkctl && go test ./... -race && cd /src/proto/gen/go && go test ./..."]

FROM alpine:3.22 AS runtime

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S rostalk \
    && adduser -S -G rostalk rostalk \
    && mkdir -p /data \
    && chown rostalk:rostalk /data

COPY --from=build /out/rostalk-server /usr/local/bin/rostalk-server

USER rostalk
WORKDIR /data
VOLUME ["/data"]

# 7443: HTTPS/WSS control plane + LiveKit signalling proxy.
# 7881: ICE-TCP fallback for media.
# 7882: all media over UDP.
EXPOSE 7443/tcp 7881/tcp 7882/udp

ENTRYPOINT ["/usr/local/bin/rostalk-server"]
CMD ["run", "--data=/data"]
