# Runbook: image access for a self-hosting customer

**Plan:** `implement/28-on-prem-delivery.md` Q4 (owner decision 2026-10-15). A customer whose host reaches the
internet pulls the release from GHCR with a **pull token of its own**. A customer without internet gets the
**offline kit** instead (`infra/scripts/offline-kit.sh`, end of this runbook).

The nine images are private packages under the `nazihar` account (`ghcr.io/nazihar/12id-*`). The Android SDK
needs nothing: `maven.12id.com` is public, because the SDK ships inside apps anyway.

## Give a customer access (once per customer)
1. **A GitHub machine account for the customer**, named `12id-<customer>` (for example `12id-mtb`), with an
   address we control and 2FA on. One account per customer, so revoking one touches no other.
2. **Read access to each of the nine packages.** For each of `12id-services`, `12id-console`,
   `12id-console-tools`, `12id-mediator`, `12id-mediator-migrate`, `12id-caddy`, `12id-vdr-proxy`,
   `12id-ledger-tools` and `12id-ledger-ceremony`: GitHub → the package → Package settings → Manage access →
   Invite, the machine account, role **Read**. The account accepts each invitation.
3. **A classic personal access token** on the machine account with the `read:packages` scope only and an expiry
   date (a year at most). GHCR does not accept fine-grained tokens.
4. **Hand the token to the customer** through the channel agreed for secrets (never mail or chat in clear).
   Record the account, the token's expiry and the date in the customer's file.

The customer stores it on its host once, as the deploy user:
```sh
docker login ghcr.io -u 12id-<customer>        # the token at the password prompt
```
`infra/scripts/init.sh check` pulls one image by digest and says whether the login works.

## Renew and revoke
- **Renew** before the expiry: a new token on the machine account, handed over the same way; the customer runs
  `docker login` again. Then delete the old token.
- **Revoke:** remove the machine account from each package's access (Manage access → Remove), or delete its
  tokens. Pulls fail at once; containers already running keep running.

## Check (once, before the first customer)
Personal-account packages accept collaborators with roles (GitHub's package access control). Confirm it on one
package with a test machine account: with Read it can `docker pull ghcr.io/nazihar/12id-caddy@<digest>`; after
removal the same pull answers `unauthorized`. If personal-account packages turn out not to take collaborators,
the fallback is moving the packages to a GitHub organisation (owner decision, plan Q4). Evidence goes in
`implement/29-on-prem-delivery-findings.md`.

## A customer without internet: the offline kit
On our side, from a machine logged in to GHCR (plain `auths` in `~/.docker/config.json`, not a credential helper)
with the release's two GitHub release assets:
```sh
infra/scripts/offline-kit.sh build --release-env release-X.Y.Z.env --bundle 12id-bundle-X.Y.Z.tar.gz \
  --maven <maven part, see the SDK section of self-host.md> --sign-key <12iD release minisign key> \
  --out 12id-offline-X.Y.Z
```
- The release key is the owner's, kept offline (key id `831CF2B84B3533FA`, generated 2026-10-27). Its public key
  is `infra/12id-release.pub`. It goes to the customer **separately from the kit** (a kit could carry a forged
  one): read the key id and the `RW…` line to them on a call, or send it through another channel than the kit,
  and they compare it with what they hold before `verify`.
- The kit holds every image of the release for every platform it was published for. It is too large for a
  GitHub release asset; hand it over on a drive or through the customer's file transfer.
- The customer checks it (`offline-kit.sh verify <kit> --pub <key>`) and loads it (`offline-kit.sh load <kit>`,
  or `--registry <their registry>`); `infra/self-host.md` "Getting the images" has their side.
