/**
 * BETTER_AUTH_SECRET rotation (Phase 9 W4, infra/runbooks/key-rotation.md). Better Auth encrypts each
 * TOTP secret with the auth secret, so replacing the secret outright would break every 2FA enrollment.
 * Better Auth 1.7 has versioned secrets: the first is current (new encryptions, as `$ba$<v>$…`), the
 * others decrypt only, and `secret` decrypts the bare-hex payloads written before versions existed.
 *
 *   BETTER_AUTH_SECRET_VERSION 0 (default): exactly the behaviour before W4, one unversioned secret.
 *   N ≥ 1: BETTER_AUTH_SECRET is version N; BETTER_AUTH_SECRET_PREVIOUS, while set, is version N-1 and
 *          the legacy key. scripts/reencrypt-2fa.ts moves every TOTP secret to version N, after which
 *          the previous secret is removed.
 *
 * No imports: scripts/reencrypt-2fa.ts loads this file with plain node in the runtime image.
 */
export interface AuthSecretInput {
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_SECRET_PREVIOUS?: string
  BETTER_AUTH_SECRET_VERSION: number
}

export interface AuthSecretOptions {
  secret: string
  secrets?: Array<{ version: number; value: string }>
}

/** What auth.server.ts passes to betterAuth(). */
export function authSecretOptions(env: AuthSecretInput): AuthSecretOptions {
  const version = env.BETTER_AUTH_SECRET_VERSION
  if (version === 0) return { secret: env.BETTER_AUTH_SECRET }
  const secrets = [{ version, value: env.BETTER_AUTH_SECRET }]
  if (env.BETTER_AUTH_SECRET_PREVIOUS && version >= 2) secrets.push({ version: version - 1, value: env.BETTER_AUTH_SECRET_PREVIOUS })
  // `secret` is only Better Auth's legacy (bare-hex) key once `secrets` is set.
  return { secret: env.BETTER_AUTH_SECRET_PREVIOUS ?? env.BETTER_AUTH_SECRET, secrets }
}

/** The key object better-auth/crypto's symmetricEncrypt/Decrypt take; the same shape Better Auth builds. */
export function authSecretConfig(env: AuthSecretInput) {
  const { secret, secrets } = authSecretOptions(env)
  if (!secrets) return secret
  return {
    keys: new Map(secrets.map((s) => [s.version, s.value])),
    currentVersion: secrets[0].version,
    legacySecret: secret,
  }
}
