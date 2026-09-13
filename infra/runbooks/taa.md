# Runbook: Transaction Author Agreement (TAA)

**Status: documented only, not run.** The staging von-network has no TAA configured, so none of this has been exercised. Verify against the target network before relying on it.

## What a TAA is
Permissioned Indy networks (Sovrin MainNet, Indicio MainNet/TestNet, and others) publish a Transaction Author Agreement on their config ledger. **Every write** (NYM, SCHEMA, CLAIM_DEF, ATTRIB) must carry proof that the author accepted the current TAA:
- the TAA version or digest;
- an acceptance mechanism from the network's Acceptance Mechanism List (AML);
- a timestamp.

A write without it, or with a stale one after the network ratifies a new TAA, is rejected by the ledger. Reads never need it, so holders are unaffected.

This becomes relevant as soon as §12.1 moves off von-network to a third-party or permissioned network.

## How Credo 0.7 handles it
Configured per network on `IndyVdrModule` (from `@credo-ts/indy-vdr` 0.7.0 type declarations):

```ts
new IndyVdrModule({
  indyVdr,
  networks: [
    {
      indyNamespace: 'indicio:testnet',       // example
      isProduction: false,
      genesisTransactions,
      connectOnStartup: true,
      transactionAuthorAgreement: {
        version: '1.0',                        // optional: the TAA version you accepted
        acceptanceMechanism: 'service_agreement', // a key from the network's AML
      },
    },
  ],
})
```

`IndyVdrPool` fetches the network's current `AuthorAgreement` (`digest`, `version`, `text`, `ratification_ts`, `acceptanceMechanisms.aml`) and appends the acceptance to write requests (`prepareWriteRequest` → `appendTaa`). No per-request code is needed once the network entry is configured.

## Procedure when onboarding to a network with a TAA
1. **Read the current TAA and AML from the ledger.** With the staging `indy-vdr-proxy` pointed at that network's genesis (W10):
   ```sh
   curl -s https://vdr.<domain>/taa   # text, version, digest, ratification_ts
   curl -s https://vdr.<domain>/aml   # acceptance mechanisms and their descriptions
   ```
   Or use the network operator's published copy, and confirm the digest matches the ledger.
2. **Legal review.** Accepting the TAA is a legal act on behalf of the organisation. Record who accepted it, when, and the exact version and digest. This is a business decision, not an engineering default.
3. **Choose the acceptance mechanism** that matches how acceptance happened (for example `service_agreement` or `on_file`). The value must be a key in the ledger's AML.
4. **Configure** `transactionAuthorAgreement` on every agent that writes to that network: the endorser bootstrap (`infra/ledger`), the issuer agents (Phase 2), and any tooling that publishes schemas or credential definitions. Holders and verifiers only read and need nothing.
5. **Verify with a single write** (for example a throwaway NYM or schema on a test network) before any real publication.
6. **Keep the record** (version, digest, mechanism, acceptor, date) alongside the environment's secrets and findings.

## When the network ratifies a new TAA
- Writes start failing once the new TAA takes effect. Read-only paths keep working, which makes this easy to miss.
- Repeat steps 1–5 for the new version, update `version` in every writer's configuration, and redeploy the writers.
- Monitoring (W7) should include a periodic write probe against each network the platform writes to. That probe is what catches both this and the silent consensus failure recorded in the W1 findings.
