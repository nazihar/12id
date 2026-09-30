#!/usr/bin/env python3
"""Genesis ceremony for 12id's own Indy network (Phase 9 W2, 18-phase-9-production.md W2.5).

Runs once, in the ceremony image (the pinned indy_node image plus `age`), before the validators ever
start. It uses indy-plenum's own transaction builders, the same code as indy-node's
`generate_indy_pool_transactions`, but with random keys instead of that tool's fixed test seeds
(von-network's public Trustee seed is 17-phase-7.md L16).

- Each validator's node and BLS keys are generated straight into that validator's data volume
  (/nodes/node<N>, mounted as /var/lib/indy by the validator). Their seeds are not kept: a lost key
  is replaced with a NODE transaction signed by the node's steward.
- Trustee and steward DIDs come from random 32-byte seeds generated here. A seed is never printed or
  written in plain text: each one goes through `age` to /out/custody/<name>.seed.age, encrypted to the
  offline custody keys in /custody-recipients (<name>.txt if present, else default.txt; one age
  recipient per line). The trustee seeds are needed again only to sign ledger governance (the endorser
  bootstrap, a new validator, a genesis rotation); the steward seeds only for their node's NODE txns.
- Public outputs in /out: pool_transactions_genesis, domain_transactions_genesis, trustees.csv,
  stewards.csv, nodes.csv, ceremony.json. The same genesis files go into every validator volume.

It refuses to run if any validator volume already holds keys or a genesis file: a network is never
regenerated over an existing one.

Settings (environment):
  NETWORK_NAME   indy network directory name, e.g. twelveid (= the validators' INDY_NETWORK_NAME)
  NODE_COUNT     validators (default 4); names Node1..NodeN, stewards Steward1..StewardN
  NODE_IPS       comma-separated node_ip per validator: validator-to-validator addresses (a private
                 Docker network in production, never published)
  CLIENT_IPS     comma-separated client_ip per validator, or one address for all: what phones and
                 agents connect to (production: the VM's public IP)
  PORT_BASE      node N listens on PORT_BASE + 2(N-1) (node) and PORT_BASE + 2(N-1) + 1 (client);
                 default 9701, so the client ports are 9702/9704/9706/9708
  TRUSTEE_COUNT  trustees (default 3); Trustee1 writes the others and the stewards in genesis
"""
import contextlib
import csv
import io
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

NODES_DIR = '/nodes'
OUT_DIR = '/out'
RECIPIENTS_DIR = '/custody-recipients'


def fail(message):
    print(f'ceremony: {message}', file=sys.stderr)
    sys.exit(1)


def setting(name, default=None):
    value = os.environ.get(name, default)
    if value in (None, ''):
        fail(f'{name} is required')
    return value


network = setting('NETWORK_NAME')
node_count = int(setting('NODE_COUNT', '4'))
trustee_count = int(setting('TRUSTEE_COUNT', '3'))
port_base = int(setting('PORT_BASE', '9701'))
node_ips = setting('NODE_IPS').split(',')
client_ips = setting('CLIENT_IPS').split(',')
if len(client_ips) == 1:
    client_ips = client_ips * node_count
if len(node_ips) != node_count or len(client_ips) != node_count:
    fail(f'NODE_IPS and CLIENT_IPS need {node_count} entries (CLIENT_IPS may have one)')
if node_count < 4:
    fail('fewer than 4 validators cannot tolerate a single failure')

# plenum reads NETWORK_NAME from the config file at import time.
with open('/etc/indy/indy_config.py', 'a') as config_file:
    config_file.write(f'\nNETWORK_NAME = {network!r}\n')

from plenum.common.constants import STEWARD, TRUSTEE  # noqa: E402
from plenum.common.keygen_utils import initNodeKeysForBothStacks  # noqa: E402
from plenum.common.member.member import Member  # noqa: E402
from plenum.common.member.steward import Steward  # noqa: E402
from plenum.common.signer_did import DidSigner  # noqa: E402
from plenum.common.util import hexToFriendly  # noqa: E402
from ledger.genesis_txn.genesis_txn_file_util import create_genesis_txn_init_ledger  # noqa: E402

POOL_FILE = 'pool_transactions'
DOMAIN_FILE = 'domain_transactions'
GENESIS_SUFFIX = '_genesis'

# Refuse to overwrite anything.
for n in range(1, node_count + 1):
    network_dir = os.path.join(NODES_DIR, f'node{n}', network)
    if not os.path.isdir(os.path.join(NODES_DIR, f'node{n}')):
        fail(f'{NODES_DIR}/node{n} is not mounted')
    for existing in ('keys', POOL_FILE + GENESIS_SUFFIX, DOMAIN_FILE + GENESIS_SUFFIX):
        if os.path.exists(os.path.join(network_dir, existing)):
            fail(f'node{n} already has {existing}; a ceremony never runs over an existing network')
if os.path.exists(os.path.join(OUT_DIR, POOL_FILE + GENESIS_SUFFIX)):
    fail(f'{OUT_DIR} already holds a genesis; use an empty output directory')
if not os.path.isfile(os.path.join(RECIPIENTS_DIR, 'default.txt')):
    fail(f'{RECIPIENTS_DIR}/default.txt (the offline age recipients) is required')


def custody(name, seed):
    """Encrypts one seed (hex) to the offline recipients. The plain seed only exists in memory and
    on age's stdin."""
    recipients = os.path.join(RECIPIENTS_DIR, f'{name}.txt')
    if not os.path.isfile(recipients):
        recipients = os.path.join(RECIPIENTS_DIR, 'default.txt')
    target = os.path.join(OUT_DIR, 'custody', f'{name}.seed.age')
    subprocess.run(['age', '--encrypt', '--recipients-file', recipients, '--output', target],
                   input=seed.hex().encode(), check=True)
    return target


def new_did(name):
    seed = os.urandom(32)
    signer = DidSigner(seed=seed)
    custody(name, seed)
    return signer


os.makedirs(os.path.join(OUT_DIR, 'custody'), exist_ok=True)

trustees = [new_did(f'trustee-{i}') for i in range(1, trustee_count + 1)]
stewards = [new_did(f'steward-{i}') for i in range(1, node_count + 1)]

# Domain genesis: Trustee1 (self-created), the other trustees and the stewards, created by Trustee1.
domain = create_genesis_txn_init_ledger(OUT_DIR, DOMAIN_FILE)
domain.reset()
seq_no = 1
first = trustees[0]
domain.add(Member.nym_txn(first.identifier, verkey=first.verkey, role=TRUSTEE, seq_no=seq_no, protocol_version=None))
for trustee in trustees[1:]:
    seq_no += 1
    domain.add(Member.nym_txn(trustee.identifier, verkey=trustee.verkey, role=TRUSTEE, creator=first.identifier,
                              seq_no=seq_no, protocol_version=None))
for steward in stewards:
    seq_no += 1
    domain.add(Member.nym_txn(steward.identifier, verkey=steward.verkey, role=STEWARD, creator=first.identifier,
                              seq_no=seq_no, protocol_version=None))
domain.stop()

# Pool genesis: one NODE txn per validator, keys generated into its own volume.
pool = create_genesis_txn_init_ledger(OUT_DIR, POOL_FILE)
pool.reset()
nodes = []
for n in range(1, node_count + 1):
    alias = f'Node{n}'
    keys_dir = os.path.join(NODES_DIR, f'node{n}', network, 'keys')
    os.makedirs(keys_dir, exist_ok=True)
    # initNodeKeysForBothStacks prints the seed it was given; keep that out of every log.
    with contextlib.redirect_stdout(io.StringIO()):
        _, verkey, bls_key, bls_proof = initNodeKeysForBothStacks(alias, keys_dir, os.urandom(32), override=False)
    verkey = verkey.encode() if isinstance(verkey, str) else verkey
    node_port = port_base + 2 * (n - 1)
    client_port = node_port + 1
    node = {
        'alias': alias,
        'dest': hexToFriendly(verkey),
        'steward': stewards[n - 1].identifier,
        'node_ip': node_ips[n - 1],
        'node_port': node_port,
        'client_ip': client_ips[n - 1],
        'client_port': client_port,
        'bls_key': bls_key,
    }
    pool.add(Steward.node_txn(node['steward'], alias, node['dest'], node['node_ip'], node_port, client_port,
                              client_ip=node['client_ip'], blskey=bls_key, bls_key_proof=bls_proof,
                              seq_no=n, protocol_version=None))
    nodes.append(node)
pool.stop()

# Every validator gets the same genesis, and owns its files (uid of `indy` in the image).
pool_path = os.path.join(OUT_DIR, POOL_FILE + GENESIS_SUFFIX)
domain_path = os.path.join(OUT_DIR, DOMAIN_FILE + GENESIS_SUFFIX)
for n in range(1, node_count + 1):
    network_dir = os.path.join(NODES_DIR, f'node{n}', network)
    shutil.copy(pool_path, network_dir)
    shutil.copy(domain_path, network_dir)
    subprocess.run(['chown', '-R', 'indy:indy', os.path.join(NODES_DIR, f'node{n}')], check=True)

with open(os.path.join(OUT_DIR, 'trustees.csv'), 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['name', 'did', 'verkey', 'custody_file'])
    for i, t in enumerate(trustees, 1):
        writer.writerow([f'trustee-{i}', t.identifier, t.full_verkey, f'custody/trustee-{i}.seed.age'])
with open(os.path.join(OUT_DIR, 'stewards.csv'), 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(['name', 'did', 'verkey', 'node', 'custody_file'])
    for i, s in enumerate(stewards, 1):
        writer.writerow([f'steward-{i}', s.identifier, s.full_verkey, f'Node{i}', f'custody/steward-{i}.seed.age'])
with open(os.path.join(OUT_DIR, 'nodes.csv'), 'w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=list(nodes[0].keys()))
    writer.writeheader()
    writer.writerows(nodes)

summary = {
    'network': network,
    'created': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    'validators': [{k: node[k] for k in ('alias', 'dest', 'client_ip', 'client_port')} for node in nodes],
    'trustees': [t.identifier for t in trustees],
    'stewards': [s.identifier for s in stewards],
    'custody': sorted(os.listdir(os.path.join(OUT_DIR, 'custody'))),
}
with open(os.path.join(OUT_DIR, 'ceremony.json'), 'w') as f:
    json.dump(summary, f, indent=2)
print(json.dumps(summary, indent=2))
