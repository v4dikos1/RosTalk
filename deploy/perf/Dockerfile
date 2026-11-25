# syntax=docker/dockerfile:1
#
# Load generator for the perf harness (stage 7.1). The image only carries
# rostalkctl: the server is a separate container built from deploy/dev/Dockerfile.
#
# Build context is the repository root:
#   docker build -f deploy/perf/Dockerfile -t rostalk-load:perf .

FROM golang:1.27 AS build

WORKDIR /src

COPY tools/rostalkctl/go.mod tools/rostalkctl/go.sum ./tools/rostalkctl/
COPY proto/gen/go/go.mod proto/gen/go/go.sum ./proto/gen/go/
RUN --mount=type=cache,target=/go/pkg/mod \
    cd tools/rostalkctl && go mod download

COPY proto/gen/go ./proto/gen/go
COPY tools/rostalkctl ./tools/rostalkctl
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd tools/rostalkctl && CGO_ENABLED=0 go build -trimpath -o /out/rostalkctl .

FROM alpine:3.22

# tc (iproute2) implements the bad-network scenarios; iptables drops UDP to
# prove the ICE-TCP fallback. Both run inside this container only.
RUN apk add --no-cache ca-certificates iproute2 iptables \
    && mkdir -p /work
COPY --from=build /out/rostalkctl /usr/local/bin/rostalkctl

WORKDIR /work
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["sleep infinity"]
