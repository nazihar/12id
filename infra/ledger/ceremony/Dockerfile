# Ledger ceremony image (Phase 9 W2): the pinned validator image plus `age` and ceremony.py.
#
# The same indy-node 1.13.2 code the validators run builds the genesis transactions and the node keys,
# so their format cannot drift. The upstream image publishes only moving `-main` tags, hence the digest.
FROM ghcr.io/hyperledger-indy/indy-node-container/indy_node:1.13.2-debian12-main@sha256:d1f7d24fda5cfd1e20eed657a3deefe051280336c86a261070b9219a61c42ebe

# age encrypts every trustee and steward seed to the offline custody keys; nothing leaves in plain text.
RUN apt-get update \
 && apt-get install -y --no-install-recommends age \
 && rm -rf /var/lib/apt/lists/*

COPY ceremony.py /usr/local/bin/12id-ceremony
RUN chmod 0555 /usr/local/bin/12id-ceremony

ENTRYPOINT ["python3", "/usr/local/bin/12id-ceremony"]
