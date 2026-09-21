#!/usr/bin/env bash
# Phase 6 smoke setup, run ON THE VM: configures a tenant's biometric provider through the console
# scope from inside the platform container, where CONSOLE_TOKEN already lives (the edge refuses the
# console headers, and the token never leaves the VM).
#
#   infra/smoke/biometric-setup.sh <tenant-uuid> mock
#   infra/smoke/biometric-setup.sh <tenant-uuid> aws-rekognition '{"region":"ap-south-1","roleArn":"arn:aws:iam::…:role/…"}'
#   infra/smoke/biometric-setup.sh <tenant-uuid> external-id      # print the tenant's external id only
#
# Leaves the tenant with the provider tested and biometrics switched on, required only where a
# credential definition or proof template says so (the smoke sets those with its API key).
set -euo pipefail

TENANT="${1:?tenant uuid}"
PROVIDER="${2:?mock | aws-rekognition | external-id}"
CONFIG="${3:-{\}}"
CONTAINER="${PLATFORM_CONTAINER:-platform-platform-api-1}"

docker exec -i -e TENANT="$TENANT" -e PROVIDER="$PROVIDER" -e CONFIG="$CONFIG" "$CONTAINER" node --input-type=module -e '
const base = "http://127.0.0.1:3500"
const headers = {
  "content-type": "application/json",
  "x-console-token": process.env.CONSOLE_TOKEN,
  "x-console-actor": "smoke@biometric-setup",
  "x-console-role": "owner",
  "x-console-tenant": process.env.TENANT,
}
const call = async (method, path, body) => {
  const { "content-type": _ct, ...bare } = headers
  const res = await fetch(base + path, { method, headers: body === undefined ? bare : headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`)
  return json
}
const current = await call("GET", "/v1/biometrics")
console.log("external id:", current.externalId)
if (process.env.PROVIDER === "external-id") process.exit(0)
await call("PUT", "/v1/biometrics/provider", { providerId: process.env.PROVIDER, config: JSON.parse(process.env.CONFIG) })
const test = await call("POST", "/v1/biometrics/provider/test")
console.log("provider test:", test.status, test.error ?? "")
if (test.status !== "ok") process.exit(1)
const on = await call("PUT", "/v1/biometrics/settings", { enabled: true, defaultPolicy: { required: false, minMatchScore: 90, minLivenessScore: 90, maxAttempts: 3, ttlMinutes: 30 } })
console.log("biometrics enabled:", on.enabled, "provider:", on.provider?.id)
'
