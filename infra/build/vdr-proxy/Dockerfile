# indy-vdr-proxy (W10): ledger reads over HTTPS on 443, the hedge for networks that block
# the Indy client ports (4-init §4.6, §12.9).
#
# indy-vdr publishes no proxy binary or image (checked at v0.4.5), so build from the pinned
# tag. The repository moved: hyperledger/indy-vdr -> hyperledger-indy/indy-vdr.
FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS build

ARG INDY_VDR_REF=v0.4.5

# zmq_vendored and libgit2 compile native code.
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "$INDY_VDR_REF" https://github.com/hyperledger-indy/indy-vdr.git .

# Default features: fetch + zmq_vendored. No `tls`: Caddy terminates TLS.
RUN cargo build --release -p indy-vdr-proxy

# curl: the compose healthcheck (Phase 9 W2; the proxy hung after a pool timeout on 2026-09-27).
FROM debian:12-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 libstdc++6 curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin vdrproxy

COPY --from=build /src/target/release/indy-vdr-proxy /usr/local/bin/indy-vdr-proxy

USER vdrproxy
ENTRYPOINT ["indy-vdr-proxy"]
