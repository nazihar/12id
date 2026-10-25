# Runbook: the ledger ceremony (our own Indy network)

> **Since implement/28 (platform 0.11.0): `infra/scripts/init.sh ledger new` runs the steps below** (and
> `init.sh endorser` the trustee bootstrap), stopping where a person must act. This runbook stays the
> reference for what the ceremony creates and why. The validators' subnet is `LEDGER_SUBNET_PREFIX` (default
> `192.168.97`), not a fixed one.

**Applies to:** production (`compose.ledger-nodes.yml`, owner decision 2026-09-28, `18-phase-9-production.md` W2.5).
Staging keeps von-network (`17-phase-7.md` L16). Rehearsed locally on 2026-09-29 (`19-phase-9-production-findings.md` W2).

The ceremony creates a new Indy network once: 4 validators on the app VM, 3 trustees, one steward per
validator. It never runs over an existing network (it refuses if any validator volume has keys or a genesis).

## What is created, and where it lives

| Item | Where | Secret? |
|---|---|---|
| Each validator's node and BLS keys | That validator's volume `12id-ledger-node<N>-data` only | Yes. Backed up (encrypted) nightly. A lost key is replaced by a NODE txn signed by the node's steward |
| 3 trustee DIDs (random seeds) | `custody/trustee-<N>.seed.age`, encrypted to the offline recipients | Yes. **Offline custody.** Needed only for governance: the endorser bootstrap, a new validator, a genesis rotation |
| 4 steward DIDs (random seeds) | `custody/steward-<N>.seed.age` | Yes. Offline custody. Needed to change their validator (keys, address) |
| `pool_transactions_genesis`, `domain_transactions_genesis` | the output directory and every validator volume | No. The pool genesis is published, signed, as `genesis.<domain>/v1/` |
| `trustees.csv`, `stewards.csv`, `nodes.csv`, `ceremony.json` | the output directory | No. Commit them under `infra/env/<env>/ledger/` |

No seed is ever printed, logged, or written in plain text: `ceremony.py` generates them in memory and pipes
each one straight into `age`. The validators' `INDY_NODE_SEED` stays unset.

**Why node_ip is private:** the genesis advertises each validator's node address as its fixed IP on the
private `12id-ledger` Docker network (192.168.97.11–14), and node ports are never published. Only the client
ports (9702/9704/9706/9708) are public, with the VM's public IP as `client_ip`. This removes staging's
hairpin through the provider NAT and its `DOCKER-USER` rules (6-phase-1-findings W1). Moving a validator to
its own host later changes its node_ip with a NODE txn ([genesis-rotation.md](genesis-rotation.md)).

**No TAA:** our own network has no transaction author agreement (owner decision, 18-phase-9 Decisions).

## Before: the custody keys (owner)
1. Decide who holds the trustee keys. With three people, each trustee seed can go to a different key.
2. Each holder creates an age key **on an offline machine** (`age-keygen -o trustee.key`) and hands over only
   the public key (`age1…`).
3. On the VM, write the public keys (never a private key):
   ```sh
   sudo install -d -m 0755 /opt/12id/ceremony/recipients /opt/12id/ceremony/out
   echo age1...  | sudo tee /opt/12id/ceremony/recipients/default.txt     # every seed without its own file
   echo age1...  | sudo tee /opt/12id/ceremony/recipients/trustee-2.txt   # optional: split custody
   ```
   `default.txt` may list several recipients (one per line): every one of them can decrypt.

## Steps (on the VM as `ubuntu`, `ENV=production`)
1. **Check the settings** in `infra/env/production.env`: `LEDGER_NETWORK_NAME`, and `PUBLIC_IP` (the
   `client_ip` every phone will use; frozen in the genesis).
2. **Run the ceremony** (no network, `--rm`). It creates the validators' volumes and fills them:
   ```sh
   export ENV=production
   infra/scripts/deploy.sh ledger-nodes run --rm ceremony
   ```
   It prints `ceremony.json`: the validators with their `client_ip`/`client_port`, the trustee and steward DIDs,
   and the custody files. Check that `client_ip` is the public IP.
3. **Move the custody files off the VM** (`/opt/12id/ceremony/out/custody/*.seed.age`) to each holder's offline
   media, then delete them from the VM. They are encrypted; the VM never had a key that decrypts them.
4. **Start the validators and check consensus:**
   ```sh
   infra/scripts/deploy.sh ledger-nodes up -d
   docker logs ledger-nodes-node1-1 2>&1 | grep -i -E 'catchup|primary|view change' | tail
   ```
   Every node should report the same primary within a minute.
5. **Publish genesis v1**, signed (the production minisign key, W5):
   ```sh
   GENESIS_SOURCE=/opt/12id/ceremony/out/pool_transactions_genesis \
     MINISIGN_KEY=/opt/12id/secrets/minisign.key infra/scripts/snapshot-genesis.sh v1
   ```
   Put its sha256 into `infra/env/production.env` (`GENESIS_SHA256`) and redeploy the edge (vdr-proxy).
6. **Generate the write probe's key** and **bootstrap the endorser with a trustee** (the only time a
   trustee key is online). The endorser key itself is generated inside its Askar store and never leaves it.
   ```sh
   infra/scripts/set-secret.sh ledger LEDGER_PROBE_SEED --generate
   infra/scripts/pg-roles.sh agent                       # the empty `endorser` database for Askar
   # The holder decrypts the seed on the VM from offline media; it goes over a pipe, never to disk:
   age -d -i /media/offline/trustee-1.key /media/offline/trustee-1.seed.age \
     | infra/scripts/deploy.sh ledger run --rm -T bootstrap-endorser
   ```
   The output names the endorser DID (`did:indy:<namespace>:<nym>`) and the probe DID. Put the endorser DID
   into `production.env` (`ENDORSER_DID`). Unmount the offline media.
7. **Enable the write probe** (`12id-ledger-probe.timer`, `ENV=production` in `/etc/default/12id`) and check
   `ledger_write_probe_success 1` in `/opt/12id/metrics/ledger_write_probe.prom`.
8. **Commit the public outputs** (`trustees.csv`, `stewards.csv`, `nodes.csv`, `ceremony.json`, the genesis
   files) under `infra/env/production/ledger/`, and record the ceremony in the findings.

## Using a trustee or steward key later
Always the same pattern: the holder decrypts on the VM from offline media into a pipe, one command, then
removes the media. Never copy a seed file or a decrypted seed to the VM's disk.
