/** Row shapes of platform-api responses, from the generated client types (client-safe, types only). */
import type { paths } from '@/server/platform-api'

type Ok<P extends keyof paths, M extends 'get' | 'post' | 'put'> = paths[P][M] extends { responses: { 200: { content: { 'application/json': infer T } } } } ? T : never

export type ConnectionRow = Ok<'/v1/connections', 'get'>[number]
export type CredentialRow = Ok<'/v1/credentials', 'get'>[number]
export type ProofRow = Ok<'/v1/proofs', 'get'>[number]
export type WalletRow = Ok<'/v1/wallets', 'get'>[number]
export type DeliveryRow = Ok<'/v1/webhook/deliveries', 'get'>[number]
export type DeliveryDetail = Ok<'/v1/webhook/deliveries/{id}', 'get'>
export type ApiKeyRow = Ok<'/v1/api-keys', 'get'>[number]
export type SchemaRow = Ok<'/v1/schemas', 'get'>[number]
export type CredentialDefinitionRow = Ok<'/v1/credential-definitions', 'get'>[number]
export type TemplateRow = Ok<'/v1/proof-templates', 'get'>[number]
export type WebhookEndpoint = Ok<'/v1/webhook', 'get'>

export const DELIVERY_STATUSES = ['pending', 'sending', 'delivered', 'dead'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

export const WEBHOOK_EVENT_TYPES = ['connection.state_changed', 'credential.state_changed', 'proof.state_changed', 'wallet.sync_requested'] as const
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]
