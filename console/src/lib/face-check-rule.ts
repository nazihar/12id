/**
 * A conditional face-check rule in words (proof templates, Phase 6): shared by the tenant portal's
 * template pages and the exchange lists both consoles show.
 */
export const CONDITION_OPS = ['gte', 'gt', 'lte', 'lt'] as const
export type ConditionOp = (typeof CONDITION_OPS)[number]
export const CONDITION_MATCHES = ['any', 'all'] as const
export type ConditionMatch = (typeof CONDITION_MATCHES)[number]

export const CONDITION_OP_SYMBOLS: Record<ConditionOp, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<' }

/** e.g. `amount ≥ 5000 or riskScore > 70`. */
export function describeRule(rule: { match: ConditionMatch; conditions: ReadonlyArray<{ param: string; op: ConditionOp; value: number }> }): string {
  return rule.conditions.map((row) => `${row.param} ${CONDITION_OP_SYMBOLS[row.op]} ${row.value}`).join(rule.match === 'any' ? ' or ' : ' and ')
}
