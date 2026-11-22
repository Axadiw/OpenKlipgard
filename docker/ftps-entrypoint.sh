#!/bin/sh
# Starts the FTP server with the address it gives cameras for the data
# connection, FTP_PASV_URL [ARCH-107, ARCH-108].
#
# compose passes FTP_HOST as FTP_PASV_URL. When FTP_HOST is empty, the address
# is the one the `init-certs` service resolved from PUBLIC_URL at this start and
# left in the certs volume (docker/ftp-host.sh).
#
# The server replaces this script (exec). It is then the main process of the
# container, so it receives the stop signal and can finish its transfers.
set -eu

# FTP_HOST_FILE is for tests. The container always uses the default.
host_file="${FTP_HOST_FILE:-/certs/ftp-host}"

if [ -z "${FTP_PASV_URL:-}" ]; then
    FTP_PASV_URL=$(cat "$host_file" 2>/dev/null || true)
fi
if [ -z "$FTP_PASV_URL" ]; then
    echo "The FTP server has no camera address: FTP_PASV_URL is empty and $host_file has none." >&2
    echo "Set FTP_HOST in .env, then run 'docker compose up -d' again." >&2
    exit 1
fi
export FTP_PASV_URL
exec "$@"
