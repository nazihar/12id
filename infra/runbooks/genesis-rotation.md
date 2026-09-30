# Runbook: publishing a new genesis version

**Applies to:** staging (`https://genesis.12id.naziharitsolution.com`). The same rules apply to any environment that serves genesis to agents and the holder SDK.

## Why versions are immutable
Agents bake in the genesis URL, and the holder SDK caches the file. A published `vN` is served with `Cache-Control: public, max-age=31536000, immutable`, so a changed file under the same URL would reach clients unpredictably, possibly never. Changing validators, IPs or ports therefore always means publishing `vN+1`, never editing `vN`.

`snapshot-genesis.sh` enforces this: it refuses to write a version directory that already exists, and marks published files read-only.

## When to publish a new version
- A validator is added, removed, or changes its IP or client port.
- The pool is reset (von-network `./manage down` + `start` creates a new ledger, and the old genesis points at a ledger that no longer exists).
- Moving to a different network (the §12.1 decision: a third-party network or our own validators).

## Steps
Run on the VM as `ubuntu`.

1. **Confirm the pool is healthy and writes work.** A ready web server is not enough (see findings W1, "the first firewall rule broke consensus silently"):
   ```sh
   curl -s http://127.0.0.1:9000/status | grep '"ready": true'
   ```
   Then register a throwaway NYM (see findings W2) or run the endorser bootstrap.
2. **Publish the next version, signed:**
   ```sh
   cd /opt/12id/infra/scripts
   MINISIGN_KEY=/opt/12id/secrets/minisign.key ./snapshot-genesis.sh v2
   ```
   The script aborts if the validator count is wrong or any node advertises a private or Docker-internal address.
3. **Verify from outside the VM:**
   ```sh
   G=https://genesis.12id.naziharitsolution.com
   curl -fsS $G/v2/pool_transactions_genesis -o g && curl -fsS $G/v2/pool_transactions_genesis.sha256 -o g.sha256
   sed -i 's/pool_transactions_genesis/g/' g.sha256 && sha256sum -c g.sha256
   curl -fsS $G/v2/pool_transactions_genesis.minisig -o g.minisig
   minisign -V -p infra/env/staging/genesis-signing.pub -m g -x g.minisig
   ```
4. **Update consumers in the repo** to the new URL and sha256:
   - `GENESIS_VERSION` / `GENESIS_SHA256` in `infra/env/<env>.env` (Phase 9: every compose file reads them)
   - smoke tests and agents (W8, Phase 2)
   - the SDK's configured version (Phase 5)
5. **Keep old versions online** until every consumer has moved. Remove a version only once nothing references it; clients with a cached copy are unaffected either way.
6. **Record the change** (version, sha256, reason) in the environment's findings or changelog.

## Our own network: move a validator to its own host (Phase 9 W2)
Production starts with all four validators on the app VM (owner decision 2026-09-28). Moving one out
changes its addresses, which only its steward may sign, and every client needs the new addresses, hence
a new genesis version.

1. **New host:** Docker, the pinned `indy_node` image digest from `compose.ledger-nodes.yml`, ufw allowing
   the node port only from the other validators' public addresses and the client port from anywhere.
2. **Copy the validator's volume** with the node stopped (`deploy.sh ledger-nodes stop node4`, then
   `docker run --rm -v 12id-ledger-node4-data:/d alpine tar -C /d -cz .` over SSH into the new host's
   volume). Its keys move with it; nothing is regenerated.
3. **Node addresses:** on the new host the node listens on its public address, and the three nodes left
   on the VM must become reachable from it. Their `node_ip` is the private `192.168.97.x`, so they also
   need a NODE txn each (public IP, node port published and firewalled to the validators only), signed by
   each one's steward. Do those first, one node at a time, waiting for consensus after each.
4. **The moved node's NODE txn:** its steward signs the new `node_ip`/`client_ip` (and ports). The steward
   seed comes from offline custody over a pipe, as in [ledger-ceremony.md](ledger-ceremony.md).
5. **Start it on the new host**, check that it catches up (`validator-info`) and that the write probe passes.
6. **Publish `vN+1`** of the genesis from the current pool ledger (the steps above), and move every
   consumer to it: `GENESIS_VERSION`/`GENESIS_SHA256` in `infra/env/production.env`, the SDK's configured
   version. Old versions stay online; a client with an old genesis still finds the pool through the nodes
   that did not move and refreshes.

## Signing key
- Private key: `/opt/12id/secrets/minisign.key` on the VM, also stored as `MINISIGN_SECRET_KEY_B64` in `infra/env/staging/secrets/genesis.sops.env`.
- Public key: `infra/env/staging/genesis-signing.pub` (key id `169255404DD823AD`).
- **If the key is lost or rotated,** every consumer that verifies signatures needs the new public key. Publish the next genesis version signed with the new key, and ship the public key through the same channel as the URL change.
