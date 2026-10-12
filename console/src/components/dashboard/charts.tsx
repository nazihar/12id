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
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts'

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

export interface OutcomeSeries {
  key: string
  label: string
  /** A status token for a state, or the neutral for "no outcome". Never a categorical slot: these are states, not series. */
  color: string
}

export type OutcomePoint = { day: string } & Record<string, number | string>

/**
 * What became of the things started each day (implement/22 C10): one stacked column per day,
 * segmented by outcome. Part-to-whole over time, so the columns stack; the legend is always present
 * and the tooltip carries the numbers. With many days the columns are thin, so the gap between
 * segments narrows rather than swallow them.
 */
export function OutcomeColumns({ data, series, emptyText, testId }: { data: OutcomePoint[]; series: OutcomeSeries[]; emptyText: string; testId?: string }) {
  const hydrated = useHydrated()
  if (!hydrated) return <Skeleton className={`${HEIGHT} w-full`} data-testid={testId} />
  const config = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig
  const empty = data.every((point) => series.every((s) => Number(point[s.key] ?? 0) === 0))
  const gap = data.length > 45 ? 1 : 2
  // The data end of a column is its topmost segment, whichever outcome that is on the day.
  const topOf = (point: OutcomePoint) => series.findLast((s) => Number(point[s.key] ?? 0) > 0)?.key
  return (
    <div className="relative" data-testid={testId} data-empty={empty || undefined}>
      <ChartContainer config={config} className={`${HEIGHT} w-full`}>
        <BarChart data={data} barCategoryGap="20%" margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={6} interval="preserveStartEnd" minTickGap={28} tickFormatter={shortDay} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
          <ChartTooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTooltipContent className="min-w-48" labelFormatter={(value) => String(value)} />} />
          {/* The legend follows the stack, bottom to top, not the alphabet. */}
          <ChartLegend itemSorter={null} content={<ChartLegendContent className="flex-wrap" />} />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} stackId="outcome" fill={`var(--color-${s.key})`} stroke="var(--card)" strokeWidth={gap} maxBarSize={28} isAnimationActive={false}>
              {data.map((point) => (
                <Cell key={point.day} {...({ radius: topOf(point) === s.key ? [4, 4, 0, 0] : 0 } as object)} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
      {empty && <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">{emptyText}</p>}
    </div>
  )
}

/**
 * A ranked list with a bar per row: magnitude of a handful of named things. One series, so one hue
 * and no legend; every row carries its own label and number, so nothing depends on colour or hover.
 * A row is a button when `onSelect` is given (it filters the list below the chart).
 */
export function BarList({ rows, selected, onSelect, testId }: { rows: Array<{ key: string; label: string; value: number }>; selected?: string; onSelect?: (key: string | undefined) => void; testId?: string }) {
  const hydrated = useHydrated()
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <ul className="space-y-2" data-testid={testId}>
      {rows.map((row) => {
        const body = (
          <>
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="font-medium tabular-nums">{row.value}</span>
            </span>
            <span className="mt-1 block h-2 rounded-full bg-muted">
              <span className="block h-2 min-w-1 rounded-full bg-chart-1" style={{ width: `${(row.value / max) * 100}%` }} />
            </span>
          </>
        )
        return (
          <li key={row.key}>
            {onSelect ? (
              <button
                type="button"
                disabled={!hydrated}
                aria-pressed={selected === row.key}
                onClick={() => onSelect(selected === row.key ? undefined : row.key)}
                className="block w-full rounded-md p-1.5 text-left outline-hidden hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted"
              >
                {body}
              </button>
            ) : (
              <div className="p-1.5">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * How scores of 0–100 spread, in ten buckets, with the minimum a score must reach marked on the same
 * scale. Plain markup: ten columns need no chart library, render the same on the server, and each
 * non-empty column carries its count. One series, one hue; the threshold is a line with a label.
 */
export function ScoreHistogram({ buckets, threshold, label, testId }: { buckets: number[]; threshold: number; label: string; testId?: string }) {
  const max = Math.max(1, ...buckets)
  const total = buckets.reduce((sum, n) => sum + n, 0)
  return (
    <figure data-testid={testId} data-empty={total === 0 || undefined}>
      <figcaption className="mb-6 flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{total} scored attempt{total === 1 ? '' : 's'}</span>
      </figcaption>
      <div className="relative">
        <div className="flex h-28 items-end gap-0.5 border-b" role="img" aria-label={`${label}: ${buckets.map((n, i) => `${i * 10} to ${i === 9 ? 100 : i * 10 + 9}: ${n}`).join(', ')}. Minimum ${threshold}.`}>
          {buckets.map((n, index) => (
            <div key={index} className="flex h-full flex-1 flex-col justify-end" title={`${index * 10}–${index === 9 ? 100 : index * 10 + 9}: ${n}`}>
              {n > 0 && <span className="text-center text-[10px] leading-4 text-muted-foreground tabular-nums">{n}</span>}
              <span className="block rounded-t-sm bg-chart-1" style={{ height: n === 0 ? 0 : `max(2px, ${(n / max) * 80}%)` }} />
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 -top-5 border-l border-dashed border-foreground/70" style={{ left: `${threshold}%` }}>
          <span className={`absolute top-0 text-[10px] leading-4 whitespace-nowrap text-foreground ${threshold > 70 ? 'right-1' : 'left-1'}`}>minimum {threshold}</span>
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums" aria-hidden>
        <span>0</span>
        <span>50</span>
        <span>100</span>
      </div>
    </figure>
  )
}
