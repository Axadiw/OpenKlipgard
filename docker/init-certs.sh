#!/bin/sh
# First-start certificate setup, run by the `init-certs` service on every
# `docker compose up`. Certificates are made only while one is missing. The
# camera address is resolved at every start.
#
# Creates a private CA plus two certificates in the `certs` volume, and the
# key the services authenticate to each other with:
#   - object storage (MinIO): encryption with per-account keys (SSE-C) is only
#     allowed over TLS, so the internal storage endpoint must speak HTTPS even
#     though it never leaves the compose network;
#   - FTP server: a self-signed certificate for cameras that use FTPS. Cameras
#     do not validate it. Replace fullchain.pem / privkey.pem with a real
#     certificate if your FTP clients do.
#   - internal-api-key: shared by the API, the FTP server and the MCP server.
#     Nothing stored depends on it. To replace it, delete the file and run
#     `docker compose down && docker compose up -d`.
set -e

# The address cameras use to reach this machine: FTP_HOST, or the IPv4 host of
# PUBLIC_URL when FTP_HOST is empty [ARCH-108]. A start with neither stops here,
# with the message of docker/ftp-host.sh, before the API or the FTP server
# starts [ARCH-109]. The FTP server reads the result from the certs volume.
ftp_host=$(/bin/sh /ftp-host.sh)
printf '%s\n' "$ftp_host" > /certs/ftp-host
chmod 644 /certs/ftp-host

if [ ! -f /certs/public.crt ] || [ ! -f /certs/fullchain.pem ] || [ ! -s /certs/internal-api-key ]; then
    # The base image has no openssl tool. It is installed from the image's own
    # Alpine release, so only the first start (or one after the certs volume
    # was removed) needs internet access.
    command -v openssl >/dev/null 2>&1 || apk add -q --no-cache openssl
fi

if [ ! -f /certs/public.crt ]; then
    echo "Generating the internal CA and the object-storage certificate..."
    openssl genrsa -out /certs/ca.key 2048
    openssl req -x509 -new -nodes -key /certs/ca.key -sha256 -days 3650 \
        -out /certs/ca.crt -subj '/CN=Klipgard internal CA'
    openssl genrsa -out /certs/private.key 2048
    openssl req -new -key /certs/private.key -out /tmp/server.csr -subj '/CN=minio'
    printf '[SAN]\nsubjectAltName=DNS:minio,DNS:localhost,IP:127.0.0.1\n' > /tmp/san.ext
    openssl x509 -req -in /tmp/server.csr \
        -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial \
        -out /certs/public.crt -days 3650 -sha256 \
        -extfile /tmp/san.ext -extensions SAN
    # M-02: the CA key is only needed to sign the storage certificate above.
    # Remove it so a compromised container that shares the certs volume
    # (e.g. MinIO, which runs as root) cannot forge new certificates.
    rm -f /certs/ca.key /certs/ca.srl
fi

if [ ! -f /certs/fullchain.pem ]; then
    echo "Generating the FTP server certificate..."
    openssl req -x509 -newkey rsa:2048 \
        -keyout /certs/privkey.pem -out /certs/fullchain.pem \
        -days 3650 -nodes -subj "/CN=${ftp_host}" 2>/dev/null
fi

if [ ! -s /certs/internal-api-key ]; then
    echo "Generating the internal API key..."
    openssl rand -hex 32 > /certs/internal-api-key.tmp
    mv /certs/internal-api-key.tmp /certs/internal-api-key
fi

# Private key permissions. `privkey.pem` (the FTPS TLS key) belongs to the FTPS
# user (uid 1001, see ftps.Dockerfile) and nobody else can read it. It is owned
# by the user and not shared through a group: the image gives that user a system
# group, and its number is not 1001. Other services (API uid=1000, MinIO uid=0)
# need only `ca.crt` and `fullchain.pem`. `private.key` (the MinIO TLS key) is
# 640 root:0: MinIO (uid=0) reads it, and no other service needs it.
# `internal-api-key` stays 644: every service reads it at startup for
# inter-service authentication. This runs on every start, so an installation
# that keeps an older permission is corrected when it is updated.
chmod 640 /certs/private.key
chown 0:0 /certs/private.key
chown 1001:1001 /certs/privkey.pem
chmod 400 /certs/privkey.pem
chmod 644 /certs/internal-api-key
echo "Certificates and internal key ready."
