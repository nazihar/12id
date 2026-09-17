/**
 * The two chart forms of the dashboards (Phase 4 C8), on shadcn `ui/chart` (recharts).
 *
 *   ActivityChart  trend over time, three distinct series → grouped columns per day, legend always
 *                  present, values in the tooltip (no number on every bar).
 *   OutcomeBar     part-to-whole → one horizontal stacked bar per exchange kind, segmented by the
 *                  state group (done / in flight / abandoned). Those are states, not series, so they
 *                  take the status palette and carry direct labels.
 *
 * recharts measures its container on mount, so the server pass has no real size and the first client
 * render differs from it. Every chart therefore renders a same-height skeleton until `useHydrated()`,
 * the gate the forms and dialogs already use (traps 32, 36; C7).
 */
import { useHydrated } from '@tanstack/react-router'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'

import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'

const HEIGHT = 'h-[220px]'

export interface SeriesPoint {
  day: string
  connections: number
  credentials: number
  proofs: number
}

const ACTIVITY_CONFIG = {
  connections: { label: 'Connections', color: 'var(--chart-1)' },
  credentials: { label: 'Credential exchanges', color: 'var(--chart-2)' },
  proofs: { label: 'Proof exchanges', color: 'var(--chart-3)' },
} satisfies ChartConfig

/** `2026-09-17` → `09-17`; deterministic, no locale (hydration rule behind `formatDateTime`). */
const shortDay = (day: string) => day.slice(5)

export function ActivityChart({ series, testId }: { series: SeriesPoint[]; testId?: string }) {
  const hydrated = useHydrated()
  if (!hydrated) return <Skeleton className={`${HEIGHT} w-full`} data-testid={testId} />
  const empty = series.every((point) => point.connections + point.credentials + point.proofs === 0)
  return (
    <div className="relative" data-testid={testId} data-empty={empty || undefined}>
      <ChartContainer config={ACTIVITY_CONFIG} className={`${HEIGHT} w-full`}>
        <BarChart data={series} barGap={2} barCategoryGap="20%" margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={6} interval="preserveStartEnd" minTickGap={28} tickFormatter={shortDay} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
          <ChartTooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTooltipContent className="min-w-48" labelFormatter={(value) => String(value)} />} />
          <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />
          <Bar dataKey="connections" fill="var(--color-connections)" radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
          <Bar dataKey="credentials" fill="var(--color-credentials)" radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
          <Bar dataKey="proofs" fill="var(--color-proofs)" radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      {empty && <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">No exchanges started in this window.</p>}
    </div>
  )
}

export type OutcomeGroup = 'done' | 'inFlight' | 'abandoned'

export interface OutcomeRow {
  kind: string
  done: number
  inFlight: number
  abandoned: number
}

const OUTCOME_CONFIG = {
  done: { label: 'Done', color: 'var(--status-good)' },
  inFlight: { label: 'In flight', color: 'var(--status-warning)' },
  abandoned: { label: 'Abandoned', color: 'var(--status-critical)' },
} satisfies ChartConfig

/** Buckets platform-api's exchange states into the three outcome groups. */
export function outcomeRow(kind: string, byState: Record<string, number>, terminal: { done: string[]; abandoned: string[] }): OutcomeRow {
  const row: OutcomeRow = { kind, done: 0, inFlight: 0, abandoned: 0 }
  for (const [state, n] of Object.entries(byState)) {
    if (terminal.done.includes(state)) row.done += n
    else if (terminal.abandoned.includes(state)) row.abandoned += n
    else row.inFlight += n
  }
  return row
}

export function OutcomeBar({ rows, testId }: { rows: OutcomeRow[]; testId?: string }) {
  const hydrated = useHydrated()
  if (!hydrated) return <Skeleton className={`${HEIGHT} w-full`} data-testid={testId} />
  const empty = rows.every((row) => row.done + row.inFlight + row.abandoned === 0)
  return (
    <div className="relative" data-testid={testId} data-empty={empty || undefined}>
      <ChartContainer config={OUTCOME_CONFIG} className={`${HEIGHT} w-full`}>
        <BarChart data={rows} layout="vertical" barCategoryGap="28%" margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid horizontal={false} strokeDasharray="0" />
          <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="kind" tickLine={false} axisLine={false} width={92} />
          <ChartTooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTooltipContent className="min-w-40" />} />
          <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />
          <Bar dataKey="done" stackId="outcome" fill="var(--color-done)" stroke="var(--card)" strokeWidth={2} isAnimationActive={false} />
          <Bar dataKey="inFlight" stackId="outcome" fill="var(--color-inFlight)" stroke="var(--card)" strokeWidth={2} isAnimationActive={false} />
          <Bar dataKey="abandoned" stackId="outcome" fill="var(--color-abandoned)" stroke="var(--card)" strokeWidth={2} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      {empty && <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">No exchanges yet.</p>}
    </div>
  )
}
