# syntax=docker/dockerfile:1

# Production image for rostalk-server.
#
#   docker build -f deploy/docker/Dockerfile -t rostalk-server .
#   docker run -d --name rostalk -p 7443:7443 -p 7881:7881 -p 7882:7882/udp \
#     -v rostalk-data:/data -e ROSTALK_PUBLIC_HOST=203.0.113.5 rostalk-server \
#     run --data=/data --public-host=203.0.113.5
#
# The runtime is a small Alpine image with an unprivileged user and a data
# volume. Ports are published with -p; never use --network host (CONTRIBUTING.md,
# ADR 0001: it does not behave the same on Docker Desktop).
#
# The release public key is compiled in so `rostalk-server update --release-url
# ...` can verify signatures inside the container.

FROM golang:1.27 AS build

WORKDIR /src

COPY server/go.mod server/go.sum ./server/
COPY proto/gen/go/go.mod proto/gen/go/go.sum ./proto/gen/go/
RUN --mount=type=cache,target=/go/pkg/mod \
    cd server && go mod download

COPY proto/gen/go ./proto/gen/go
COPY server/ ./server/

ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILT_AT=unknown
# Base64 DER of deploy/release.pub. release.sh and install.sh use the same key.
ARG RELEASE_PUBKEY_B64=MCowBQYDK2VwAyEA8Dp673Q0lj2oVoVWU/ZtYNOlnqMSPq8ETppbc7tasbc=

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd server && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath \
        -ldflags="-s -w \
          -X github.com/v4dikos1/RosTalk/server/internal/version.Version=${VERSION} \
          -X github.com/v4dikos1/RosTalk/server/internal/version.Commit=${COMMIT} \
          -X github.com/v4dikos1/RosTalk/server/internal/version.Date=${BUILT_AT} \
          -X github.com/v4dikos1/RosTalk/server/internal/release.PublicKeyBase64=${RELEASE_PUBKEY_B64}" \
        -o /out/rostalk-server ./cmd/rostalk-server

FROM alpine:3.22 AS runtime

# ca-certificates is needed for --domain (Let's Encrypt) and `update`; tzdata
# keeps log timestamps readable in local time.
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 1000 rostalk \
    && adduser -S -u 1000 -G rostalk -h /data -s /sbin/nologin rostalk \
    && mkdir -p /data \
    && chown rostalk:rostalk /data

COPY --from=build /out/rostalk-server /usr/local/bin/rostalk-server

USER rostalk
WORKDIR /data
VOLUME ["/data"]

# 7443/tcp: HTTPS/WSS control plane and signalling proxy.
# 7881/tcp: ICE-TCP fallback for media.
# 7882/udp: all media over UDP.
# 80/443 are only used with --domain (Let's Encrypt challenges).
EXPOSE 7443/tcp 7881/tcp 7882/udp 80/tcp 443/tcp

HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
    CMD ["/bin/sh", "-c", "/usr/local/bin/rostalk-server healthcheck --data=/data ${ROSTALK_DOMAIN:+--domain=$ROSTALK_DOMAIN} || exit 1"]

ENTRYPOINT ["/usr/local/bin/rostalk-server"]
CMD ["run", "--data=/data", "--listen=:7443"]
