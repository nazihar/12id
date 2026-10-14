#!/usr/bin/env bash
# AWS Face Liveness options check (implement/15-phase-6-biometric.md "Liveness options"), run ON THE VM
# like biometric-setup.sh: console scope from inside the platform container, real AWS behind it.
#
#   infra/smoke/liveness-options-check.sh <tenant-uuid> '{"region":"ap-south-1","roleArn":"arn:aws:iam::…:role/…"}' [final-options-json]
#
# The tenant's role must trust 12id with the tenant's external id. Checks: the catalogue describes the
# options; defaults for a configuration without them; a real connection test with each challenge;
# changing only options keeps the tested status; back camera with light refused; a new region resets
# it. Leaves the tenant on aws-rekognition, tested, with the final options (default: AWS defaults).
set -euo pipefail

TENANT="${1:?tenant uuid}"
CONNECTION="${2:?connection json: region and roleArn}"
FINAL="${3:-{\}}"
CONTAINER="${PLATFORM_CONTAINER:-platform-platform-api-1}"

docker exec -i -e TENANT="$TENANT" -e CONNECTION="$CONNECTION" -e FINAL="$FINAL" "$CONTAINER" node --input-type=module -e '
const base = "http://127.0.0.1:3500"
const token = (await import("node:fs")).readFileSync(process.env.CONSOLE_TOKEN_FILE, "utf8").trim()
const headers = { "content-type": "application/json", "x-console-token": token, "x-console-actor": "smoke@liveness-options-check", "x-console-role": "owner", "x-console-tenant": process.env.TENANT }
const call = async (method, path, body) => {
  const { "content-type": _ct, ...bare } = headers
  const res = await fetch(base + path, { method, headers: body === undefined ? bare : headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
let failed = 0
let n = 0
const check = (label, ok, detail = "") => { n++; if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${n}. ${label}${detail ? " — " + detail : ""}`) }
const connection = JSON.parse(process.env.CONNECTION)
const put = (config) => call("PUT", "/v1/biometrics/provider", { providerId: "aws-rekognition", config })
const test = async () => (await call("POST", "/v1/biometrics/provider/test")).body
const provider = async () => (await call("GET", "/v1/biometrics")).body.provider

const catalogue = (await call("GET", "/v1/biometrics/providers")).body.providers.find((p) => p.id === "aws-rekognition")
const props = catalogue?.configSchema?.properties ?? {}
check("catalogue describes the options", props.challenge?.title === "Liveness challenge" && props.startScreen?.default === "show" && props.camera?.optionLabels?.back === "Back" && props.roleArn?.title === "IAM role ARN", Object.keys(props).join(","))

let r = await put(connection)
const defaults = r.body.provider?.publicConfig ?? {}
check("a configuration without options reads as the AWS defaults", r.status === 200 && defaults.challenge === "FaceMovementAndLightChallenge" && defaults.startScreen === "show" && defaults.camera === "front", JSON.stringify(defaults))
let t = await test()
check("connection test with the light challenge (real AWS)", t.status === "ok", t.error ?? "")
const testedAt = (await provider()).lastTestedAt

r = await put({ ...connection, challenge: "FaceMovementChallenge" })
check("changing only the challenge keeps the tested status", r.status === 200 && r.body.provider?.status === "ok" && r.body.provider?.lastTestedAt === testedAt, `${r.body.provider?.status} ${r.body.provider?.lastTestedAt}`)
t = await test()
check("connection test with the challenge without light (real AWS accepts ChallengePreferences)", t.status === "ok", t.error ?? "")

r = await put({ ...connection, challenge: "FaceMovementAndLightChallenge", camera: "back" })
check("back camera with the light challenge refused", r.status === 400 && JSON.stringify(r.body).includes("back camera"), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`)
check("the refused configuration changed nothing", (await provider()).publicConfig.challenge === "FaceMovementChallenge")

r = await put({ ...connection, challenge: "FaceMovementChallenge", camera: "back", startScreen: "skip" })
check("back camera and no start screen with the challenge without light: saved, still tested", r.status === 200 && r.body.provider?.status === "ok" && r.body.provider?.publicConfig.camera === "back" && r.body.provider?.publicConfig.startScreen === "skip", `${r.body.provider?.status}`)

const otherRegion = connection.region === "us-east-1" ? "eu-west-1" : "us-east-1"
r = await put({ ...connection, region: otherRegion })
check("a new region needs a new connection test", r.status === 200 && r.body.provider?.status === "untested", `${r.body.provider?.status}`)

r = await put({ ...connection, ...JSON.parse(process.env.FINAL) })
t = await test()
const final = await provider()
check("left on the final options, tested", r.status === 200 && t.status === "ok" && final.status === "ok", JSON.stringify(final.publicConfig))

console.log(failed ? `FAILED ${failed}/${n}` : `PASSED ${n}/${n}`)
process.exit(failed ? 1 : 0)
'
