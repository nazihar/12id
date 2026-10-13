/**
 * A change that was not made: it waits for a second person (implement/22-console-feedback.md C17).
 * Every server function whose change can be held answers either what it always answered or
 * `{ held }`, and the form that called it says "sent for approval" instead of "saved". Client-safe.
 */
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

/** Every approvals query starts with this key, so one invalidation refreshes the lists, the count and the notices. */
export const APPROVALS_KEY = ['approvals'] as const

export interface HeldChange {
  id: string
  /** The kind of change, as platform-api names it (`webhook.set`). */
  type: string
  label: string
  summary: string
  /** `by_requester`: once approved, the person who asked presses Apply on the Approvals page. */
  apply: 'on_approval' | 'by_requester'
}

export interface Held {
  held: HeldChange
}

export const isHeld = (value: unknown): value is Held => typeof value === 'object' && value !== null && 'held' in value && typeof (value as Held).held?.id === 'string'

/**
 * Says so when a change was held, and tells the caller (`true`) to skip what it does after a change
 * that was made. The words name what happens next, because nothing on the page has changed yet.
 */
export function announceHeld(value: unknown, queryClient?: QueryClient): value is Held {
  if (!isHeld(value)) return false
  void queryClient?.invalidateQueries({ queryKey: APPROVALS_KEY })
  const next = value.held.apply === 'by_requester' ? 'Once it is approved, apply it from Approvals.' : 'It takes effect when a second person approves it.'
  toast.info(`Sent for approval: ${value.held.summary}.`, { description: next, duration: 10_000 })
  return true
}
