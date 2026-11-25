#!/bin/sh
# Container entrypoint: sshd in the foreground. The fake systemctl and the
# generated host keys are already in the image.
set -eu

mkdir -p /run/sshd /run/systemd/system

# The test script appends a public key for the key-auth case. The directory
# must exist and have the right mode even when no key is added.
mkdir -p /root/.ssh
chmod 0700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 0600 /root/.ssh/authorized_keys

# Do not leak the test private key or the container environment into logs.
exec /usr/sbin/sshd -D -e
