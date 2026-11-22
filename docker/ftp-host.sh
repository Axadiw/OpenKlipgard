#!/bin/sh
# Prints the camera address: the address cameras use to reach this machine
# [ARCH-107, ARCH-108]. It is FTP_HOST when that is set. Otherwise it is the
# host of PUBLIC_URL, but only when that host is an IPv4 address [ARCH-109,
# ARCH-110]. Anything else stops the start with a message instead of a guess:
# a host name can lead cameras to an address they cannot reach, and a later
# switch of PUBLIC_URL to a domain (HTTPS) would change the address unseen.
#
# The `init-certs` service runs it at every start. It prints the address on
# stdout. When there is none it prints a message on stderr, never the URL (a URL
# can carry a password), and exits with 1.
set -eu

if [ -n "${FTP_HOST:-}" ]; then
    printf '%s\n' "$FTP_HOST"
    exit 0
fi

refuse() {
    {
        printf '%s\n' "$1"
        printf '%s\n' "FTP_HOST is empty, so OpenKlipgard would give cameras the address in PUBLIC_URL."
        printf '%s\n' "In .env, set FTP_HOST to the address of this machine on the cameras' network,"
        printf '%s\n' "for example FTP_HOST='192.168.1.10'. Then run 'docker compose up -d' again."
    } >&2
    exit 1
}

# Four decimal numbers from 0 to 255 without a leading zero, separated by dots.
is_ipv4() {
    case "$1" in
        ''|*[!0-9.]*|.*|*.|*..*) return 1 ;;
    esac
    # Only digits and dots are left, so the split below has four exact parts or not.
    old_ifs=$IFS
    IFS=.
    # shellcheck disable=SC2086
    set -- $1
    IFS=$old_ifs
    [ "$#" -eq 4 ] || return 1
    for number in "$@"; do
        case "$number" in
            0|[1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5]) ;;
            *) return 1 ;;
        esac
    done
}

url="${PUBLIC_URL:-}"
case "$url" in
    http://*|https://*) ;;
    *) refuse "PUBLIC_URL in .env must start with http:// or https://." ;;
esac

# scheme://[user@]host[:port][/path]
authority="${url#*://}"
authority="${authority%%/*}"
case "$authority" in
    *@*) refuse "PUBLIC_URL in .env has user information, so it names no address." ;;
esac
host="${authority%%:*}"

if ! is_ipv4 "$host"; then
    refuse "PUBLIC_URL in .env does not name an IPv4 address (like 192.168.1.10)."
fi
printf '%s\n' "$host"
