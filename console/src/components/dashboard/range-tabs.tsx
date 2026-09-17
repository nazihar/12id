import { useHydrated } from '@tanstack/react-router'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DASHBOARD_RANGES, type DashboardRange } from '@/features/dashboard/dashboard.schemas'

/**
 * 7 / 30 / 90-day presets for a dashboard. The value lives in the route search so the range is in
 * the URL and the server and client render the same window. Disabled until hydration like every
 * other control outside a form (trap 36).
 */
export function RangeTabs({ value, onChange }: { value: DashboardRange; onChange: (days: DashboardRange) => void }) {
  const hydrated = useHydrated()
  return (
    <Tabs value={String(value)} onValueChange={(next) => onChange(Number(next) as DashboardRange)}>
      <TabsList aria-label="Time range">
        {DASHBOARD_RANGES.map((days) => (
          <TabsTrigger key={days} value={String(days)} disabled={!hydrated}>
            {days} days
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
