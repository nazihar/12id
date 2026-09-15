/** Keeps only same-site relative paths; anything else is dropped (open-redirect defence). */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined
  return value
}
