# Base images are pinned to exact versions; Dependabot proposes updates.
FROM rust:1.99.1-slim-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libssl-dev git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY ftps-server/Cargo.toml ftps-server/Cargo.lock ./
COPY ftps-server/src/ ./src/
RUN cargo build --release && cp target/release/klipgard-ftps /klipgard-ftps

FROM debian:13.7-slim
# ca-certificates also provides /etc/ssl/certs/ca-certificates.crt, the list
# STORAGE_CA_BUNDLE points at for object storage with a public certificate.
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd -r ftps && useradd -r -g ftps -u 1001 ftps
COPY --from=builder /klipgard-ftps /usr/local/bin/
# Starts the server with the address it gives cameras (docker/ftps-entrypoint.sh).
# It is part of the image and not mounted from the checkout: the server runs as
# uid 1001, and a mounted file keeps the host's mode, which a strict umask
# (027) makes unreadable for that user.
COPY docker/ftps-entrypoint.sh /usr/local/bin/ftps-entrypoint.sh
RUN chmod 0755 /usr/local/bin/ftps-entrypoint.sh
EXPOSE 21
USER ftps
ENTRYPOINT ["/usr/local/bin/ftps-entrypoint.sh"]
CMD ["klipgard-ftps"]
