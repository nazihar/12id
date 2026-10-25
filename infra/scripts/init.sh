#!/usr/bin/env bash
# First-time setup of a 12id environment from the release bundle (implement/28 Q2): one guided run instead of
# the manual steps of production-bringup.md and ledger-ceremony.md. For our production and for self-hosters.
#
#   ENV=production infra/scripts/init.sh <step> [options]
#   ENV=production infra/scripts/init.sh all --ledger new --offline-recipient age1… [--email … --name …]
#
# Run on the host as the deploy user (passwordless sudo, member of the docker group), from the unpacked bundle
# in /opt/12id (infra/…), with the release's release.env as infra/compose/release.env and infra/env/$ENV.env
# filled in from template.env. ENV defaults to production.
#
# Steps, in order (`all` runs them; each one is safe to run again and keeps what exists):
#   check                       tools, Docker, the environment file, the certificate, DNS, ports, the registry
#   keys --offline-recipient age1… [--backup-pub FILE]
#                               the host's age key, .sops.yaml, backup recipients, the genesis signing key
#   secrets                     every secret of infra/compose/secrets.list, generated or asked for
#   ledger new                  the ceremony, a pause for the custody files, the validators, genesis v1
#   ledger existing --genesis FILE
#                               an existing network's genesis, signed and published as ours
#   postgres                    the two Postgres instances and their roles
#   endorser                    the endorser DID, written by a trustee whose seed arrives on stdin
#   deploy                      every stack of the release, roles again, the docker inspect check
#   timers                      nightly backup and ledger write probe (systemd)
#   verify                      health, edge probes, a ledger write
#   operator --email E --name N the first operator account; prints its one-time password
#
# Exit status: 0 done, 1 failed, 3 waiting for a person (custody files, a trustee seed): the message says what
# to do and which command continues. Progress is kept in /opt/12id/init.state.
set -euo pipefail

ENV="${ENV:-production}"
export ENV
R=/opt/12id
INFRA="$R/infra"
S="$INFRA/scripts"
BUNDLE="$INFRA/compose"
ENV_FILE="$INFRA/env/$ENV.env"
ENV_DIR="$INFRA/env/$ENV"
RELEASE_FILE="${RELEASE_FILE:-$BUNDLE/release.env}"
STATE="$R/init.state"
SECRETS_DIR="$R/secrets"
AGE_KEY="$SECRETS_DIR/age.key"
MINISIGN_KEY="$SECRETS_DIR/minisign.key"
MINISIGN_PUB="$SECRETS_DIR/minisign.pub"
CEREMONY="$R/ceremony"
GENESIS_DIR="$R/genesis"
export SOPS_AGE_KEY_FILE="$AGE_KEY"
HOST_KEYS=(CONSOLE_HOST API_HOST AGENT_HOST MEDIATOR_HOST GENESIS_HOST VDR_HOST)

say() { printf '%s\n' "$*"; }
step_title() { printf '\n== %s\n' "$*"; }
die() { printf 'init: %s\n' "$*" >&2; exit 1; }
# A person has to do something before the next step can run.
wait_for_person() { printf '\n%s\n' "$*" >&2; exit 3; }

# --- the environment file and the state file -----------------------------------------------------------------
setting() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }
set_setting() { # KEY VALUE: replaces KEY=… or appends it; values are literal (template.env)
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN { done = 0 } index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next } { print }' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE" && rm -f "$tmp"
  say "  $ENV.env: $key=$value"
}
is_done() { [ -f "$STATE" ] && grep -q "^$ENV $1 " "$STATE"; }
mark_done() { printf '%s %s %s\n' "$ENV" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE"; }
state_value() { [ -f "$STATE" ] && sed -n "s/^$ENV $1=\([^ ]*\) .*/\1/p" "$STATE" | tail -1 || true; }
set_state_value() { printf '%s %s=%s %s\n' "$ENV" "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STATE"; }

deploy() { "$S/deploy.sh" "$@"; }
# Runs a command with its output in init.log (Compose's pull progress, mostly); shows the end of it on failure.
LOG="$R/init.log"
quiet() {
  local rc=0 start
  printf '\n### %s %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$LOG"
  start="$(wc -l < "$LOG")"
  "$@" >> "$LOG" 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || { tail -n +"$((start + 1))" "$LOG" | tail -15 | sed 's/^/  | /' >&2; die "failed ($rc): $* (whole output: $LOG)"; }
}
curl_edge() { # curl against the environment's own hostnames, trusting EDGE_CA_FILE when it is set
  local ca; ca="$(setting EDGE_CA_FILE)"
  # The file may sit in the root-only TLS directory; Docker mounts it as root, this reads it the same way.
  if [ -n "$ca" ]; then curl --cacert <(sudo cat "$ca") "$@"; else curl "$@"; fi
}
genesis_url() { printf 'https://%s/%s/pool_transactions_genesis' "$(setting GENESIS_HOST)" "$(setting GENESIS_VERSION)"; }

# Names (never values) of the keys a stack's sops file holds with a non-empty value.
present_keys() {
  local f="$ENV_DIR/secrets/$1.sops.env"
  [ -f "$f" ] || return 0
  sops --decrypt --input-type dotenv --output-type dotenv "$f" | sed -n 's/^\([A-Z][A-Z0-9_]*\)=.\{1,\}$/\1/p'
}
has_secret() { present_keys "$1" | grep -qx "$2"; }

# --- check -------------------------------------------------------------------------------------------------
step_check() {
  step_title "check ($ENV)"
  local fails=0 warns=0 c v h ip
  ok() { say "  ok    $*"; }
  warn() { say "  WARN  $*"; warns=$((warns + 1)); }
  fail() { say "  FAIL  $*"; fails=$((fails + 1)); }

  [ "$(id -u)" -ne 0 ] && ok "running as $(id -un), not root" || fail "run as the deploy user, not root (scripts use sudo where needed)"
  sudo -n true 2>/dev/null && ok "passwordless sudo" || fail "the deploy user needs passwordless sudo (deploy.sh writes /opt/12id/run-secrets)"
  for c in docker sops age age-keygen minisign openssl curl python3 sha256sum awk; do
    command -v "$c" > /dev/null && ok "$c" || fail "$c is not installed (self-host.md: the host)"
  done
  if docker info > /dev/null 2>&1; then ok "Docker $(docker version --format '{{.Server.Version}}')"; else fail "docker does not answer for $(id -un) (docker group?)"; fi
  v="$(docker compose version --short 2>/dev/null || true)"
  [ -n "$v" ] && ok "Docker Compose $v" || fail "the Docker Compose plugin (docker compose) is missing"

  [ -d "$BUNDLE" ] && ok "bundle in $INFRA" || fail "no bundle at $BUNDLE: unpack the release bundle in $R"
  [ -w "$R" ] && ok "$R is writable by $(id -un)" || fail "$R must belong to the deploy user (sudo chown $(id -un) $R)"
  if [ -f "$RELEASE_FILE" ]; then
    local missing=""
    for v in REGISTRY VERSION SERVICES_DIGEST CONSOLE_DIGEST MEDIATOR_DIGEST CADDY_DIGEST LEDGER_TOOLS_DIGEST POSTGRES_IMAGE INDY_NODE_IMAGE PROMETHEUS_IMAGE; do
      grep -q "^$v=." "$RELEASE_FILE" || missing+=" $v"
    done
    [ -z "$missing" ] && ok "release.env: $(sed -n 's/^VERSION=//p' "$RELEASE_FILE")" || fail "release.env lacks$missing (use the release-X.Y.Z.env of a release from 0.11.0 on)"
  else
    fail "no $RELEASE_FILE: copy the release's release-X.Y.Z.env there"
  fi
  "$S/check-secrets-list.sh" > /dev/null 2>&1 && ok "secrets.list matches the compose files" || fail "secrets.list does not match the compose files (check-secrets-list.sh)"

  if [ ! -f "$ENV_FILE" ]; then
    cp "$INFRA/env/template.env" "$ENV_FILE"
    fail "$ENV_FILE did not exist; it is now a copy of template.env: fill it in and run check again"
  else
    ok "$ENV.env"
    local required=(ENVIRONMENT "${HOST_KEYS[@]}" PUBLIC_IP EDGE_RATE_LIMIT_EXEMPT LEDGER_NETWORK_NAME INDY_NAMESPACE
      INDY_NETWORK_PRODUCTION GENESIS_VERSION ENDORSER_ALIAS BIOMETRIC_AWS_REGION MAIL_FROM ALERT_SMTP_SMARTHOST
      ALERT_SMTP_FROM ALERT_SMTP_USERNAME ALERT_EMAIL_TO)
    local empty=""
    for v in "${required[@]}"; do [ -n "$(setting "$v")" ] || empty+=" $v"; done
    [ -z "$empty" ] && ok "every required setting is filled" || fail "empty in $ENV.env:$empty"
    [[ "$(setting INDY_NAMESPACE)" =~ ^[a-z][_a-z0-9-]*(:[a-z][_a-z0-9-]*)?$ ]] || fail "INDY_NAMESPACE must match [a-z][_a-z0-9-]*(:[a-z][_a-z0-9-]*)?"
    [[ "$(setting GENESIS_VERSION)" =~ ^v[0-9]+$ ]] || fail "GENESIS_VERSION must look like v1"
    [ "$(setting BIOMETRIC_ENABLE_MOCK)" != true ] || warn "BIOMETRIC_ENABLE_MOCK=true: the mock face check is for tests only"
    check_tls
    for h in "${HOST_KEYS[@]}"; do
      v="$(setting "$h")"; [ -n "$v" ] || continue
      ip="$(getent hosts "$v" | awk '{ print $1; exit }')"
      if [ -z "$ip" ]; then warn "$v does not resolve on this host (the containers need it too)"
      elif [ "$ip" != "$(setting PUBLIC_IP)" ]; then warn "$v resolves to $ip, not PUBLIC_IP $(setting PUBLIC_IP)"
      else ok "$v -> $ip"; fi
    done
  fi

  check_port() { # port: free, or already ours
    if ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; then
      docker ps --format '{{.Names}} {{.Ports}}' | grep -qE "(edge-caddy|ledger-nodes)" && ok "port $1 in use by 12id" || fail "port $1 is in use by something else"
    else ok "port $1 free"; fi
  }
  check_port 80; check_port 443
  if [ "$(state_value ledger-mode)" = new ] || [ "${LEDGER_MODE:-}" = new ]; then
    for v in 9702 9704 9706 9708; do check_port "$v"; done
  fi

  local free_gb; free_gb="$(df -BG --output=avail "$R" 2>/dev/null | tail -1 | tr -dc 0-9)"
  if [ -n "$free_gb" ]; then [ "$free_gb" -ge 40 ] && ok "${free_gb} GB free on $R" || warn "${free_gb} GB free on $R; 40 GB or more is advised"; fi

  if [ -f "$RELEASE_FILE" ] && docker info > /dev/null 2>&1; then
    # One digest of the release, the smallest image: proves the registry login (a pull token or the offline kit).
    local ref; ref="$(sed -n 's/^REGISTRY=//p' "$RELEASE_FILE")/12id-caddy:$(sed -n 's/^VERSION=//p' "$RELEASE_FILE")@$(sed -n 's/^CADDY_DIGEST=//p' "$RELEASE_FILE")"
    if docker pull -q "$ref" > /dev/null 2>&1; then ok "registry: pulled $ref"
    else fail "cannot pull $ref: log in to the registry (docker login with the pull token) or load the offline kit"; fi
  fi

  say ""
  say "check: $fails failed, $warns warnings"
  [ "$fails" -eq 0 ] || exit 1
}

check_tls() {
  local mode dir ca h cert
  mode="$(setting EDGE_TLS)"; mode="${mode:-acme}"
  case "$mode" in
    acme)
      [ -n "$(setting ACME_EMAIL)" ] && ok "TLS: Let's Encrypt, account $(setting ACME_EMAIL)" || fail "EDGE_TLS=acme needs ACME_EMAIL"
      [ -z "$(setting EDGE_CA_FILE)" ] || warn "EDGE_CA_FILE is set, but EDGE_TLS=acme uses public certificates"
      ;;
    files)
      dir="$(setting EDGE_TLS_DIR)"; dir="${dir:-/opt/12id/tls}"
      cert="$dir/fullchain.pem"
      if ! sudo test -s "$cert" || ! sudo test -s "$dir/privkey.pem"; then
        fail "EDGE_TLS=files needs $cert and $dir/privkey.pem"; return
      fi
      sudo openssl x509 -in "$cert" -noout -checkend 0 > /dev/null && ok "TLS: $cert valid until $(sudo openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)" || fail "$cert has expired"
      sudo openssl x509 -in "$cert" -noout -checkend 2592000 > /dev/null || warn "$cert expires within 30 days"
      for h in "${HOST_KEYS[@]}"; do
        [ -n "$(setting "$h")" ] || continue
        sudo openssl x509 -in "$cert" -noout -checkhost "$(setting "$h")" | grep -q 'does match' || fail "$cert does not cover $(setting "$h")"
      done
      [ "$(sudo openssl x509 -in "$cert" -noout -pubkey | sha256sum)" = "$(sudo openssl pkey -in "$dir/privkey.pem" -pubout | sha256sum)" ] \
        && ok "TLS: the key matches the certificate" || fail "$dir/privkey.pem is not the key of $cert"
      ca="$(setting EDGE_CA_FILE)"
      if [ -n "$ca" ]; then
        if sudo test -s "$ca"; then
          sudo openssl verify -CAfile "$ca" -untrusted "$cert" "$cert" > /dev/null 2>&1 && ok "TLS: $cert chains to EDGE_CA_FILE" || fail "$cert does not chain to $ca"
        else fail "EDGE_CA_FILE $ca is missing or empty"; fi
      elif sudo openssl verify -untrusted "$cert" "$cert" > /dev/null 2>&1; then ok "TLS: $cert chains to a public CA"
      else fail "$cert is not from a CA this host trusts: set EDGE_CA_FILE to your CA's certificate"; fi
      ;;
    internal) warn "EDGE_TLS=internal: Caddy's own CA, for rehearsals only" ;;
    *) fail "EDGE_TLS must be acme or files" ;;
  esac
}

# --- keys --------------------------------------------------------------------------------------------------
step_keys() {
  step_title "keys ($ENV)"
  local recipients=("$@") host_pub tmp f
  [ -f "$ENV_FILE" ] || die "no $ENV_FILE (run check first)"
  sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0700 "$SECRETS_DIR"
  if [ ! -f "$AGE_KEY" ]; then
    (umask 077; age-keygen -o "$AGE_KEY" 2> /dev/null)
    say "  new host age key $AGE_KEY"
  fi
  host_pub="$(age-keygen -y "$AGE_KEY")"

  # The environment's rule in .sops.yaml: the host's key and the offline key(s), whose private half never
  # touches this host (backups and secrets survive the loss of the host, 18-phase-9 M13).
  if [ ${#recipients[@]} -eq 0 ] && [ -f "$R/.sops.yaml" ]; then
    # Keep the offline recipients already in the rule.
    mapfile -t recipients < <(awk -v env="infra/env/$ENV/secrets/" 'index($0, "path_regex: " env) { grab = 1; next } grab && /age:/ { gsub(/.*age: */, ""); gsub(/,/, "\n"); print; exit }' "$R/.sops.yaml" | grep -v "^$host_pub$" | grep '^age1' || true)
  fi
  [ ${#recipients[@]} -gt 0 ] || die "keys needs --offline-recipient age1… (the public half of an offline age key: age-keygen on an offline machine)"
  for f in "${recipients[@]}"; do [[ "$f" =~ ^age1[0-9a-z]{58}$ ]] || die "not an age recipient: $f"; done

  tmp="$(mktemp)"
  if [ -f "$R/.sops.yaml" ]; then
    # Drop this environment's rule (path_regex line and the age line under it); keep everything else.
    awk -v env="infra/env/$ENV/secrets/" 'index($0, "path_regex: " env) { skip = 1; next } skip && /age:/ { skip = 0; next } { skip = 0; print }' "$R/.sops.yaml" > "$tmp"
  else
    printf '# SOPS encryption rules (written by infra/scripts/init.sh keys). Each environment encrypts to its\n# host key and its offline key(s).\ncreation_rules:\n' > "$tmp"
  fi
  printf '  - path_regex: %s\n    age: %s\n' "infra/env/$ENV/secrets/.*\\.sops\\.(env|yaml|json)\$" "$(IFS=,; echo "$host_pub,${recipients[*]}")" >> "$tmp"
  if ! cmp -s "$tmp" "$R/.sops.yaml" 2>/dev/null; then
    cp "$tmp" "$R/.sops.yaml"
    say "  .sops.yaml: $ENV encrypts to the host key and ${#recipients[@]} offline recipient(s)"
    for f in "$ENV_DIR"/secrets/*.sops.env; do
      [ -f "$f" ] || continue
      (cd "$R" && sops updatekeys -y "${f#$R/}" > /dev/null) && say "  re-keyed ${f##*/}"
    done
  fi
  rm -f "$tmp"
  mkdir -p "$ENV_DIR/secrets" "$ENV_DIR/caddy"
  { echo "# Offline age recipients of $ENV's backups (backup-postgres.sh); private keys never on a server."; printf '%s\n' "${recipients[@]}"; } > "$ENV_DIR/backup-recipients.txt"

  # The genesis signing key (minisign, no password like staging's): its public key is what every app trusts.
  if [ ! -f "$MINISIGN_KEY" ]; then
    (umask 077; minisign -G -W -p "$MINISIGN_PUB" -s "$MINISIGN_KEY" > /dev/null)
    say "  new genesis signing key $MINISIGN_KEY"
  fi
  [ -f "$MINISIGN_PUB" ] || die "$MINISIGN_PUB is missing next to $MINISIGN_KEY"
  cp "$MINISIGN_PUB" "$ENV_DIR/genesis-signing.pub"
  [ "$(setting GENESIS_SIGNING_PUBLIC_KEY)" = "$(sed -n 2p "$MINISIGN_PUB")" ] || set_setting GENESIS_SIGNING_PUBLIC_KEY "$(sed -n 2p "$MINISIGN_PUB")"
  # Also in sops (review 7), so the offline key alone recovers it with the host lost.
  if ! has_secret genesis MINISIGN_SECRET_KEY_B64; then
    base64 -w0 "$MINISIGN_KEY" | "$S/set-secret.sh" genesis MINISIGN_SECRET_KEY_B64 > /dev/null
    say "  genesis.sops.env: MINISIGN_SECRET_KEY_B64"
  fi
  if [ -n "${BACKUP_PUB:-}" ]; then
    [ -f "$BACKUP_PUB" ] || die "--backup-pub $BACKUP_PUB: no such file"
    cp "$BACKUP_PUB" "$ENV_DIR/genesis-signing-backup.pub"
    say "  backup genesis key: $ENV_DIR/genesis-signing-backup.pub"
  fi
  say "  apps trust: $(sed -n 2p "$MINISIGN_PUB")$( [ -f "$ENV_DIR/genesis-signing-backup.pub" ] && printf ' and %s' "$(sed -n 2p "$ENV_DIR/genesis-signing-backup.pub")")"
  mark_done keys
}

# --- secrets -----------------------------------------------------------------------------------------------
step_secrets() {
  step_title "secrets ($ENV)"
  [ -f "$R/.sops.yaml" ] || die "run keys first"
  local -A stacks_of kind_of template_of
  local order=() stack key kind template
  while read -r stack key kind template; do
    [[ -z "$stack" || "$stack" == \#* ]] && continue
    [ -n "${kind_of[$key]:-}" ] || order+=("$key")
    stacks_of[$key]="${stacks_of[$key]:+${stacks_of[$key]},}$stack"
    kind_of[$key]="$kind"
    template_of[$key]="$template"
  done < "$BUNDLE/secrets.list"

  local -A present
  local s
  for s in $(printf '%s\n' "${stacks_of[@]}" | tr , '\n' | sort -u); do
    while read -r key; do present[$s/$key]=1; done < <(present_keys "$s")
  done

  # with_value <KEY>: a stack that already holds it; missing <KEY>: the stacks that do not.
  with_value() { local s; for s in ${stacks_of[$1]//,/ }; do [ -z "${present[$s/$1]:-}" ] || { echo "$s"; return 0; }; done; return 0; }
  missing() { local s out=""; for s in ${stacks_of[$1]//,/ }; do [ -n "${present[$s/$1]:-}" ] || out+="${out:+,}$s"; done; echo "$out"; }

  local pass k src miss ref ref_stack
  for pass in plain derived; do
    for k in "${order[@]}"; do
      kind="${kind_of[$k]}"
      [ "$pass" = derived ] && [ "$kind" != derived ] && continue
      [ "$pass" = plain ] && [ "$kind" = derived ] && continue
      [ "$kind" = empty ] && continue
      miss="$(missing "$k")"
      [ -n "$miss" ] || { say "  kept      $k"; continue; }
      src="$(with_value "$k")"
      if [ -n "$src" ]; then
        # A shared key set in one stack only: copy that value to the others.
        "$S/set-secret.sh" "$src,$miss" "$k" --from "$k" > /dev/null
        say "  shared    $k ($src -> $miss)"
      else
        case "$kind" in
          generate) "$S/set-secret.sh" "$miss" "$k" --generate > /dev/null; say "  generated $k ($miss)" ;;
          base64) "$S/set-secret.sh" "$miss" "$k" --generate-base64 > /dev/null; say "  generated $k ($miss)" ;;
          prompt|optional)
            if [ "$(state_value "skip-$k")" = 1 ]; then say "  skipped   $k (left empty earlier)"; continue; fi
            if [ ! -t 0 ]; then
              [ "$kind" = optional ] || wait_for_person "secrets: $k needs a value ($(secret_hint "$k")). Run in a terminal: ENV=$ENV $0 secrets
or set it first: ENV=$ENV infra/scripts/set-secret.sh $miss $k"
              say "  skipped   $k (optional, no terminal; later: ENV=$ENV infra/scripts/set-secret.sh $miss $k)"
              continue
            fi
            if [ "$kind" = optional ]; then
              local answer
              read -r -p "  $k ($miss) is optional ($(secret_hint "$k")). Set it now? [y/N] " answer
              if [[ ! "$answer" =~ ^[Yy] ]]; then set_state_value "skip-$k" 1; say "  skipped   $k"; continue; fi
            else
              say "  $k ($miss): $(secret_hint "$k")"
            fi
            "$S/set-secret.sh" "$miss" "$k" > /dev/null
            say "  set       $k ($miss)"
            ;;
          derived)
            ref="${template_of[$k]#*\{}"; ref="${ref%%\}*}"
            ref_stack="$(with_value "$ref")"
            [ -n "$ref_stack" ] || die "$k is derived from $ref, which has no value"
            # --from rewrites the reference with its own value; --also writes the derived key from it
            # (set-secret.sh's template takes {} for the value).
            local tpl="${template_of[$k]}" also=()
            tpl="${tpl/"{$ref}"/"{}"}"
            for s in ${miss//,/ }; do also+=(--also "$s:$k=$tpl"); done
            "$S/set-secret.sh" "$ref_stack" "$ref" --from "$ref" "${also[@]}" > /dev/null
            say "  derived   $k ($miss)"
            ;;
        esac
      fi
      for s in ${miss//,/ }; do present[$s/$k]=1; done
    done
  done
  mark_done secrets
}

secret_hint() {
  case "$1" in
    SMTP_URL) echo "console mail: smtps://user:password@host:465 or smtp://user:password@host:587, URL-encode @ / : in the password" ;;
    GMAIL_APP_PASSWORD) echo "the alert mail account's SMTP password; empty = alerts in the UI only" ;;
    BIOMETRIC_AWS_*) echo "12id's AWS principal for face checks; empty = no AWS face checks" ;;
    *) echo "see infra/compose/secrets.list" ;;
  esac
}

# --- ledger ------------------------------------------------------------------------------------------------
step_ledger() {
  local mode="${1:-$(state_value ledger-mode)}" genesis=""
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in --genesis) genesis="${2:?--genesis FILE}"; shift 2 ;; *) die "ledger: unknown option $1" ;; esac
  done
  [ -n "$mode" ] || die "ledger needs a mode: ledger new, or ledger existing --genesis FILE"
  local was; was="$(state_value ledger-mode)"
  [ -z "$was" ] || [ "$was" = "$mode" ] || die "this environment's ledger was set up as '$was'; it cannot become '$mode'"
  [ -n "$was" ] || set_state_value ledger-mode "$mode"
  [ -n "$(setting GENESIS_SIGNING_PUBLIC_KEY)" ] && [ -f "$MINISIGN_KEY" ] || die "run keys first (the genesis signing key)"
  case "$mode" in
    new) ledger_new ;;
    existing) ledger_existing "$genesis" ;;
    *) die "ledger mode must be new or existing" ;;
  esac
  publish_edge
  mark_done ledger
}

ledger_new() {
  step_title "ledger new ($ENV)"
  local out="$CEREMONY/out" v n
  if ! is_done ledger-ceremony; then
    sudo install -d -m 0755 "$CEREMONY/recipients" "$out"
    if ! grep -qE '^age1' "$CEREMONY/recipients/default.txt" 2>/dev/null; then
      wait_for_person "ledger: the trustee and steward seeds are encrypted to the custody holders' age keys.
Each holder runs age-keygen on an offline machine and hands over the public key (age1…). Then:
  echo age1…  | sudo tee $CEREMONY/recipients/default.txt     # one or more lines: each can decrypt
  echo age1…  | sudo tee $CEREMONY/recipients/trustee-2.txt   # optional: another holder for one seed
and run: ENV=$ENV $0 ledger new"
    fi
    [ -z "$(sudo ls -A "$out")" ] || die "$out is not empty; a ceremony needs an empty output directory"
    say "  ceremony (no network, keys into the validators' volumes); its public summary:"
    deploy ledger-nodes run --rm ceremony | sed 's/^/    /'
    # The custody files are encrypted; the deploy user copies them off and deletes them.
    sudo chown -R "$(id -un):$(id -gn)" "$out/custody"
    mark_done ledger-ceremony
  fi
  if ! is_done ledger-custody; then
    if ls "$out/custody/"*.seed.age > /dev/null 2>&1; then
      wait_for_person "ledger: the ceremony wrote these custody files, each encrypted to its holder's age key:
$(ls -1 "$out/custody/" | sed 's/^/  /')
Copy each to its holder's offline media (scp from $out/custody/), have the holder check it decrypts there
(age -d -i <key> <file> | wc -c: 64), then delete them here:
  rm $out/custody/*.seed.age
and run: ENV=$ENV $0 ledger new"
    fi
    mark_done ledger-custody
  fi
  if ! is_done ledger-nodes; then
    say "  validators"
    quiet deploy ledger-nodes up -d
    for n in 1 2 3 4; do
      v=0
      until [ "$(docker inspect -f '{{.State.Health.Status}}' "ledger-nodes-node$n-1" 2>/dev/null)" = healthy ]; do
        v=$((v + 1)); [ "$v" -lt 120 ] || die "validator node$n is not healthy after 10 minutes (docker logs ledger-nodes-node$n-1)"
        sleep 5
      done
    done
    v=0
    until docker logs ledger-nodes-node1-1 2>&1 | grep -qi 'selected primary'; do
      v=$((v + 1)); [ "$v" -lt 60 ] || { say "  WARN no primary in node1's log after 5 minutes; the endorser write will tell"; break; }
      sleep 5
    done
    say "  4 validators up"
    mark_done ledger-nodes
  fi
  publish_genesis "$out/pool_transactions_genesis" 4
  sudo install -d -o "$(id -un)" "$ENV_DIR/ledger"
  for v in trustees.csv stewards.csv nodes.csv ceremony.json pool_transactions_genesis domain_transactions_genesis; do
    sudo cat "$out/$v" > "$ENV_DIR/ledger/$v" 2>/dev/null || true
  done
  say "  public outputs in $ENV_DIR/ledger/ (keep them with the environment)"
}

ledger_existing() {
  step_title "ledger existing ($ENV)"
  local file="$1" parsed nodes targets
  if [ -z "$file" ]; then
    [ -d "$GENESIS_DIR/$(setting GENESIS_VERSION)" ] && { publish_genesis "" 0; return; }
    die "ledger existing needs --genesis FILE (the network's pool_transactions_genesis)"
  fi
  [ -s "$file" ] || die "$file is empty or missing"
  # The validators and their client addresses, from the NODE transactions (type 0).
  parsed="$(python3 -c '
import json, sys
nodes = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    txn = json.loads(line)
    t = txn.get("txn", txn)
    if str(t.get("type")) != "0":
        continue
    data = t["data"]["data"]
    if "VALIDATOR" in data.get("services", ["VALIDATOR"]):
        nodes.append("%s:%s" % (data["client_ip"], data["client_port"]))
print(len(nodes), ",".join(nodes))
' "$file")" || die "$file is not an Indy pool genesis (one JSON transaction per line)"
  nodes="${parsed%% *}"; targets="${parsed#* }"
  [ "$nodes" -ge 4 ] || die "$file has $nodes validators; a network needs 4 or more"
  say "  $nodes validators: $targets"
  [ "$(setting LEDGER_CLIENT_TARGETS)" = "$targets" ] || set_setting LEDGER_CLIENT_TARGETS "$targets"
  publish_genesis "$file" "$nodes"
}

# publish_genesis <source> <validators>: signs and publishes GENESIS_VERSION once; the version is immutable.
publish_genesis() {
  local version sha; version="$(setting GENESIS_VERSION)"
  if [ ! -d "$GENESIS_DIR/$version" ]; then
    sudo install -d -o "$(id -un)" -m 0755 "$GENESIS_DIR"
    if [ "$1" = "$CEREMONY/out/pool_transactions_genesis" ]; then
      sudo cat "$1" > "$R/.genesis-source.tmp"
    else
      cp "$1" "$R/.genesis-source.tmp"
    fi
    GENESIS_ROOT="$GENESIS_DIR" GENESIS_SOURCE="$R/.genesis-source.tmp" EXPECTED_NODES="$2" MINISIGN_KEY="$MINISIGN_KEY" \
      "$S/snapshot-genesis.sh" "$version"
    rm -f "$R/.genesis-source.tmp"
  fi
  minisign -Vm "$GENESIS_DIR/$version/pool_transactions_genesis" -p "$MINISIGN_PUB" -q || die "genesis $version is not signed by $MINISIGN_PUB"
  sha="$(cut -d' ' -f1 "$GENESIS_DIR/$version/pool_transactions_genesis.sha256")"
  [ "$(setting GENESIS_SHA256)" = "$sha" ] || set_setting GENESIS_SHA256 "$sha"
  say "  genesis $version published, signed, sha256 $sha"
}

# The edge serves the genesis, which the endorser bootstrap and the agents fetch through it (review 3).
publish_edge() {
  local url want got n=0 mode
  mode="$(setting EDGE_TLS)"
  say "  edge (TLS ${mode:-acme})"
  quiet deploy edge up -d
  url="$(genesis_url)"; want="$(setting GENESIS_SHA256)"
  until got="$(curl_edge -fsS -m 10 "$url" 2>/dev/null | sha256sum | cut -d' ' -f1)" && [ "$got" = "$want" ]; do
    n=$((n + 1)); [ "$n" -lt 36 ] || die "$url does not serve the genesis after 3 minutes (DNS, the certificate: docker logs edge-caddy-1)"
    sleep 5
  done
  say "  $url serves it over TLS"
}

# --- postgres ----------------------------------------------------------------------------------------------
step_postgres() {
  step_title "postgres ($ENV)"
  [ -n "$(setting GENESIS_SHA256)" ] || die "run ledger first"
  quiet deploy mediator up -d postgres valkey
  # Compose reads every service of a file, and ENDORSER_DID is only known after the endorser step: a
  # placeholder in the shell (which wins over --env-file) for this one command (review 3).
  local endorser; endorser="$(setting ENDORSER_DID)"
  quiet env ENDORSER_DID="${endorser:-pending}" "$S/deploy.sh" agent up -d agent-postgres
  wait_healthy mediator-postgres-1 agent-agent-postgres-1
  "$S/pg-roles.sh" all | sed 's/^/  /'
  mark_done postgres
}

wait_healthy() {
  local c n
  for c in "$@"; do
    n=0
    until [ "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null)" = healthy ]; do
      n=$((n + 1)); [ "$n" -lt 60 ] || die "$c is not healthy after 5 minutes"
      sleep 5
    done
  done
}

# --- endorser ----------------------------------------------------------------------------------------------
step_endorser() {
  step_title "endorser ($ENV)"
  is_done postgres || die "run postgres first"
  if [ -t 0 ]; then
    wait_for_person "endorser: a trustee writes the endorser DID; its seed arrives on stdin, never on disk.
The trustee holder, with the offline media mounted on this host, runs:
  age -d -i /media/offline/trustee.key /media/offline/trustee-1.seed.age | ENV=$ENV $0 endorser
(an existing network: its trustee seed, 64 hex characters, the same way). Then unmount the media."
  fi
  curl_edge -fsS -m 10 -o /dev/null "$(genesis_url)" || die "the edge does not serve $(genesis_url); run ledger again"
  local out did
  out="$(mktemp)"
  if ! deploy ledger run --rm -T bootstrap-endorser > "$out" 2>&1; then
    sed 's/^/  /' "$out" | tail -20 >&2; rm -f "$out"
    die "bootstrap-endorser failed (above)"
  fi
  did="$(grep -oE '"did": *"did:indy:[^"]+"' "$out" | head -1 | sed 's/.*"\(did:indy:[^"]*\)"/\1/')"
  grep -E '"result"|"probe"' "$out" | sed 's/^/  /' || true
  rm -f "$out"
  [ -n "$did" ] || die "no endorser DID in bootstrap-endorser's output"
  [ "$(setting ENDORSER_DID)" = "$did" ] || set_setting ENDORSER_DID "$did"
  mark_done endorser
}

# --- deploy ------------------------------------------------------------------------------------------------
STACKS=(mediator agent biometric platform console monitoring edge)
step_deploy() {
  step_title "deploy ($ENV, release $(sed -n 's/^VERSION=//p' "$RELEASE_FILE"))"
  [ -n "$(setting ENDORSER_DID)" ] || die "run endorser first"
  local s
  for s in "${STACKS[@]}"; do quiet deploy "$s" pull; say "  pulled $s"; done
  quiet deploy mediator up -d
  "$S/check-mediator-tables.sh" --after-start | tail -1 | sed 's/^/  /'
  for s in agent biometric platform console monitoring edge; do
    quiet deploy "$s" up -d; say "  up $s"
  done
  wait_all_healthy
  # The services created their tables on first start; only now can the monitoring grants be applied.
  "$S/pg-roles.sh" all | sed 's/^/  /'
  "$S/check-inspect-clean.sh" | sed 's/^/  /'
  mark_done deploy
}

# Every 12id container with a health check is healthy, and no one-shot job failed.
wait_all_healthy() {
  local n=0 bad starting
  while :; do
    starting="$(docker ps --filter label=com.docker.compose.project --filter health=starting --format '{{.Names}}')"
    bad="$(docker ps --filter label=com.docker.compose.project --filter health=unhealthy --format '{{.Names}}')"
    [ -z "$bad" ] || die "unhealthy: $bad"
    [ -n "$starting" ] || break
    n=$((n + 1)); [ "$n" -lt 60 ] || die "still starting after 5 minutes: $starting"
    sleep 5
  done
  bad="$(docker ps -a --filter label=com.docker.compose.project --filter status=exited --format '{{.Names}} {{.Status}}' | grep -v 'Exited (0)' || true)"
  [ -z "$bad" ] || die "a job failed: $bad"
  say "  every service healthy"
}

# --- timers ------------------------------------------------------------------------------------------------
step_timers() {
  step_title "timers ($ENV)"
  local unit user group
  user="$(id -un)"; group="$(id -gn)"
  # The units name User=ubuntu (staging's user); this host's deploy user replaces it.
  for unit in 12id-backup.service 12id-backup.timer 12id-ledger-probe.service 12id-ledger-probe.timer; do
    sed -e "s/^User=ubuntu$/User=$user/" -e "s/^Group=ubuntu$/Group=$group/" "$INFRA/systemd/$unit" | sudo tee "/etc/systemd/system/$unit" > /dev/null
  done
  printf 'ENV=%s\n' "$ENV" | sudo tee /etc/default/12id > /dev/null
  sudo install -d -o "$user" -g "$group" -m 0700 "$R/backups"
  sudo systemctl daemon-reload
  sudo systemctl enable --now 12id-backup.timer 12id-ledger-probe.timer > /dev/null 2>&1
  say "  12id-backup.timer (nightly) and 12id-ledger-probe.timer (every 15 minutes) enabled, /etc/default/12id ENV=$ENV"
  mark_done timers
}

# --- verify ------------------------------------------------------------------------------------------------
step_verify() {
  step_title "verify ($ENV)"
  local fails=0 h path want code
  wait_all_healthy
  for h in "GENESIS_HOST /$(setting GENESIS_VERSION)/pool_transactions_genesis 200" "MEDIATOR_HOST /health 202" \
           "AGENT_HOST /readyz 200" "API_HOST /v1/health 200" "API_HOST /v1/ledger 200" "CONSOLE_HOST /api/health 200" \
           "VDR_HOST /genesis 200" "API_HOST /admin/stats 404" "MEDIATOR_HOST /invite 404"; do
    read -r host path want <<< "$h"
    code="$(curl_edge -s -o /dev/null -m 15 -w '%{http_code}' "https://$(setting "$host")$path" || true)"
    if [ "$code" = "$want" ]; then say "  ok    $code https://$(setting "$host")$path"; else say "  FAIL  $code (want $want) https://$(setting "$host")$path"; fails=$((fails + 1)); fi
  done
  if curl_edge -fsS -m 15 "https://$(setting API_HOST)/v1/ledger" | grep -q "$(setting GENESIS_SHA256)"; then say "  ok    /v1/ledger names genesis $(setting GENESIS_SHA256)"
  else say "  FAIL  /v1/ledger does not name GENESIS_SHA256"; fails=$((fails + 1)); fi
  say "  ledger write probe (up to a minute)"
  "$S/ledger-write-probe.sh" > /dev/null 2>&1 || true
  if grep -q '^ledger_write_probe_success 1' "$R/metrics/ledger_write_probe.prom" 2>/dev/null; then say "  ok    a ledger write reached consensus"
  else say "  FAIL  the ledger write probe failed ($R/metrics/ledger_write_probe.prom)"; fails=$((fails + 1)); fi
  "$S/check-inspect-clean.sh" | sed 's/^/  /' || fails=$((fails + 1))
  [ "$fails" -eq 0 ] || die "verify: $fails check(s) failed"
  mark_done verify
}

# --- operator ----------------------------------------------------------------------------------------------
step_operator() {
  local email="" name=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --email) email="${2:?}"; shift 2 ;;
      --name) name="${2:?}"; shift 2 ;;
      *) die "operator: unknown option $1" ;;
    esac
  done
  [ -n "$email" ] && [ -n "$name" ] || die "operator needs --email and --name"
  step_title "operator $email ($ENV)"
  if is_done "operator-$email"; then say "  already created"; return; fi
  local password out
  for _ in 1 2 3; do
    # Mixed classes and length for the console's password rules (implement/24); a rare refusal (a run like
    # "abcd" in the random part) just tries again.
    password="Tmp-$(openssl rand -hex 12)-Q7!"
    if out="$(deploy console run --rm console-tools npx auth create-admin --config src/server/auth.server.ts \
        --email "$email" --password "$password" --name "$name" --role operator --yes 2>&1)"; then
      mark_done "operator-$email"
      say "  created $email (operator). One-time password, shown once:"
      say ""
      say "    $password"
      say ""
      say "  Sign in at https://$(setting CONSOLE_HOST): an authenticator app is enrolled before anything else."
      return
    fi
    grep -qi 'password' <<< "$out" || break
  done
  printf '%s\n' "$out" | tail -5 >&2
  die "create-admin failed (above)"
}

# --- all ---------------------------------------------------------------------------------------------------
step_all() {
  local recipients=() ledger_args=() email="" name=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --offline-recipient) recipients+=("${2:?}"); shift 2 ;;
      --backup-pub) BACKUP_PUB="${2:?}"; shift 2 ;;
      --ledger) ledger_args=("${2:?}" "${ledger_args[@]}"); shift 2 ;;
      --genesis) ledger_args+=(--genesis "${2:?}"); shift 2 ;;
      --email) email="${2:?}"; shift 2 ;;
      --name) name="${2:?}"; shift 2 ;;
      *) die "all: unknown option $1" ;;
    esac
  done
  [ ${#ledger_args[@]} -gt 0 ] || [ -n "$(state_value ledger-mode)" ] || die "all needs --ledger new, or --ledger existing --genesis FILE"
  LEDGER_MODE="${ledger_args[0]:-$(state_value ledger-mode)}" step_check
  is_done keys && [ ${#recipients[@]} -eq 0 ] || step_keys "${recipients[@]}"
  is_done secrets || step_secrets
  is_done ledger || step_ledger "${ledger_args[@]}"
  is_done postgres || step_postgres
  is_done endorser || step_endorser
  is_done deploy || step_deploy
  is_done timers || step_timers
  step_verify
  if [ -n "$email" ]; then
    step_operator --email "$email" --name "$name"
  else
    say ""
    say "Done. The first operator account: ENV=$ENV $0 operator --email you@example.com --name 'Your Name'"
  fi
}

# -----------------------------------------------------------------------------------------------------------
[ "$(id -u)" -ne 0 ] || die "run as the deploy user, not root"
cmd="${1:?usage: [ENV=production] init.sh check|keys|secrets|ledger|postgres|endorser|deploy|timers|verify|operator|all [options]}"
shift
case "$cmd" in
  check) step_check ;;
  keys)
    recipients=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --offline-recipient) recipients+=("${2:?}"); shift 2 ;;
        --backup-pub) BACKUP_PUB="${2:?}"; shift 2 ;;
        *) die "keys: unknown option $1" ;;
      esac
    done
    step_keys "${recipients[@]}" ;;
  secrets) step_secrets ;;
  ledger) step_ledger "$@" ;;
  postgres) step_postgres ;;
  endorser) step_endorser ;;
  deploy) step_deploy ;;
  timers) step_timers ;;
  verify) step_verify ;;
  operator) step_operator "$@" ;;
  all) step_all "$@" ;;
  *) die "unknown step $cmd" ;;
esac
