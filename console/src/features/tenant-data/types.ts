/** Row shapes of platform-api responses, from the generated client types (client-safe, types only). */
import type { paths } from '@/server/platform-api'

type Ok<P extends keyof paths, M extends 'get' | 'post' | 'put'> = paths[P][M] extends { responses: { 200: { content: { 'application/json': infer T } } } } ? T : never

export type ConnectionRow = Ok<'/v1/connections', 'get'>['items'][number]
export type CredentialRow = Ok<'/v1/credentials', 'get'>['items'][number]
export type ProofRow = Ok<'/v1/proofs', 'get'>['items'][number]
export type WalletRow = Ok<'/v1/wallets', 'get'>['items'][number]
export type DeliveryRow = Ok<'/v1/webhook/deliveries', 'get'>['items'][number]
export type DeliveryDetail = Ok<'/v1/webhook/deliveries/{id}', 'get'>
export type ApiKeyRow = Ok<'/v1/api-keys', 'get'>['items'][number]
export type SchemaRow = Ok<'/v1/schemas', 'get'>['items'][number]
export type CredentialDefinitionRow = Ok<'/v1/credential-definitions', 'get'>['items'][number]
export type TemplateRow = Ok<'/v1/proof-templates', 'get'>['items'][number]
export type WebhookEndpoint = Ok<'/v1/webhook', 'get'>
// Phase 6 biometric gate.
export type BiometricLog = Ok<'/v1/credentials/{id}/biometric-log', 'get'>
export type BiometricLogEvent = BiometricLog['events'][number]
export type BiometricSettings = Ok<'/v1/biometrics', 'get'>
export type BiometricProviderEntry = Ok<'/v1/biometrics/providers', 'get'>['providers'][number]
export type CredentialDefinitionBiometricPolicy = Ok<'/v1/credential-definitions/{id}/biometric-policy', 'get'>
export type ExchangeKind = 'credential' | 'proof'

export const DELIVERY_STATUSES = ['pending', 'sending', 'delivered', 'dead'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

export const WEBHOOK_EVENT_TYPES = ['connection.state_changed', 'credential.state_changed', 'proof.state_changed', 'wallet.sync_requested', 'biometric.check_completed', 'record.erased'] as const
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]
