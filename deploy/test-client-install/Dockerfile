FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# sshd for the client, sudo for the non-root path, tar/openssl/sha256sum for
# install.sh, iproute2 for the port preflight, procps for pidof in the harness.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-server sudo tar openssl ca-certificates coreutils iproute2 procps netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /run/systemd/system /var/lib/rostalk /var/backups/rostalk \
    && echo 'root:rootpass' | chpasswd \
    && useradd -m -s /bin/bash rostalktest \
    && echo 'rostalktest:rostalkpass' | chpasswd \
    && usermod -aG sudo rostalktest \
    && ssh-keygen -A

COPY sshd_config /etc/ssh/sshd_config
COPY fake-systemctl /usr/local/bin/systemctl
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh /usr/local/bin/systemctl

EXPOSE 22 7443 7881 7882/udp
ENTRYPOINT ["/entrypoint.sh"]
