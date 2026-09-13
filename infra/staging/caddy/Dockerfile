# Caddy with the rate_limit handler (W6). Stock Caddy has no rate limiting, and a Caddyfile
# using `rate_limit` fails to load on the stock image.
#
# caddy-ratelimit has a single, old tag (v0.1.0), so it is pinned to a commit.
FROM caddy:2.11.4-builder AS builder

ARG CADDY_RATELIMIT_COMMIT=5625512f24f6f59d6f64fb3aafe5eecff0b286db

RUN xcaddy build v2.11.4 \
    --with github.com/mholt/caddy-ratelimit@${CADDY_RATELIMIT_COMMIT}

FROM caddy:2.11.4

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Fail the build if the module did not make it in.
RUN caddy list-modules | grep -q '^http.handlers.rate_limit$'
