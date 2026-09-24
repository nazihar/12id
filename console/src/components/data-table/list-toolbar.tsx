/**
 * Toolbar pieces of the server-driven lists (Phase 4 C9), after shadcn's data-table toolbar: one
 * search box, then dashed "faceted" filter buttons that show their selection as badges, and a
 * created-date range in a calendar popover. Each reports a change; the page writes it to the URL,
 * which reloads the list from the server.
 */
import { useHydrated } from '@tanstack/react-router'
import { CalendarIcon, ChevronDownIcon, PlusCircleIcon, SearchIcon } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { DateRange } from 'react-day-picker'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { PAGE_SIZES, type PageSize } from '@/lib/list-search'

export interface FilterOption<T extends string> {
  value: T
  label: string
}

const SEARCH_DEBOUNCE_MS = 300

/** Search box: types locally, reports after a pause; the URL value wins when it changes elsewhere. */
export function SearchInput({ value, placeholder, onChange }: { value?: string; placeholder: string; onChange: (value: string | undefined) => void }) {
  const [text, setText] = useState(value ?? '')
  const reported = useRef(value ?? '')
  const report = useRef(onChange)
  report.current = onChange
  const hydrated = useHydrated()

  useEffect(() => {
    if ((value ?? '') !== reported.current) {
      reported.current = value ?? ''
      setText(value ?? '')
    }
  }, [value])

  useEffect(() => {
    if (text.trim() === reported.current) return
    const timer = setTimeout(() => {
      reported.current = text.trim()
      report.current(text.trim() || undefined)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text])

  return (
    <div className="relative w-full sm:w-64">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder={placeholder} aria-label={placeholder} readOnly={!hydrated} className="h-8 pl-8" />
    </div>
  )
}

/** The dashed filter button: title, then the selection as badges (collapsed to a count past two). */
function FacetButton({ title, icon, selected, testId, ...props }: { title: string; icon?: ReactNode; selected: string[]; testId?: string } & React.ComponentProps<typeof Button>) {
  return (
    <Button variant="outline" size="sm" className="h-8 border-dashed" data-testid={testId} aria-label={selected.length ? `${title}: ${selected.join(', ')}` : title} {...props}>
      {icon ?? <PlusCircleIcon />}
      {title}
      {selected.length > 0 && (
        <>
          <Separator orientation="vertical" className="mx-0.5 data-vertical:h-4" />
          {selected.length > 2 ? (
            <Badge variant="secondary" className="rounded-sm px-1 font-normal">
              {selected.length} selected
            </Badge>
          ) : (
            selected.map((label) => (
              <Badge key={label} variant="secondary" className="rounded-sm px-1 font-normal">
                {label}
              </Badge>
            ))
          )}
        </>
      )}
    </Button>
  )
}

/** One choice or none, e.g. a status. */
export function SelectFilter<T extends string>({ label, options, value, onChange, testId }: { label: string; options: ReadonlyArray<FilterOption<T>>; value?: T; onChange: (value: T | undefined) => void; testId?: string }) {
  const hydrated = useHydrated()
  const selected = options.find((option) => option.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={!hydrated} render={<FacetButton title={label} selected={selected ? [selected.label] : []} testId={testId} />} />
      <DropdownMenuContent align="start" className="w-auto min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(next) => onChange(next ? (next as T) : undefined)}>
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {value && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange(undefined)}>Clear filter</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Any number of choices, e.g. exchange states. None selected means all. */
export function MultiFilter<T extends string>({ label, options, value = [], onChange, testId }: { label: string; options: ReadonlyArray<FilterOption<T>>; value?: T[]; onChange: (value: T[] | undefined) => void; testId?: string }) {
  const hydrated = useHydrated()
  const toggle = (option: T, checked: boolean) => {
    const next = checked ? [...value, option] : value.filter((v) => v !== option)
    onChange(next.length ? options.map((o) => o.value).filter((v) => next.includes(v)) : undefined)
  }
  const labels = options.filter((o) => value.includes(o.value)).map((o) => o.label)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={!hydrated} render={<FacetButton title={label} selected={labels} testId={testId} />} />
      <DropdownMenuContent align="start" className="w-auto min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuCheckboxItem key={option.value} checked={value.includes(option.value)} onCheckedChange={(checked) => toggle(option.value, checked)} closeOnClick={false}>
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {value.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange(undefined)}>Clear filter</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// The URL carries UTC days (YYYY-MM-DD); the calendar works with local dates for the same day number.
const toDate = (day?: string) => {
  if (!day) return undefined
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const toDay = (date?: Date) => (date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : undefined)
const dayLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const rangeLabel = (from?: Date, to?: Date) => {
  if (!from) return ''
  if (!to || toDay(from) === toDay(to)) return dayLabel.format(from)
  return `${dayLabel.format(from)} – ${dayLabel.format(to)}`
}
const PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
] as const

/**
 * Created between two days, both inclusive, picked on a two-month calendar. The first click starts
 * the range and the second ends it; closing the popover keeps a one-day range. Presets apply at once.
 */
export function DateRangeFilter({ from, to, onChange, label = 'Created' }: { from?: string; to?: string; onChange: (range: { from?: string; to?: string }) => void; label?: string }) {
  const hydrated = useHydrated()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange | undefined>()
  const clicks = useRef(0)
  const current: DateRange | undefined = from ? { from: toDate(from), to: toDate(to) } : undefined

  const commit = (range: DateRange | undefined) => {
    const next = { from: toDay(range?.from), to: toDay(range?.to ?? range?.from) }
    if (next.from !== from || next.to !== to) onChange(next)
  }
  const openChange = (next: boolean) => {
    if (next) {
      setDraft(current)
      clicks.current = 0
    } else if (clicks.current > 0) {
      commit(draft)
    }
    setOpen(next)
  }
  const select = (range: DateRange | undefined, day: Date) => {
    clicks.current += 1
    // The first click always starts a new range; react-day-picker would otherwise extend the old one.
    if (clicks.current === 1) {
      setDraft({ from: day, to: undefined })
      return
    }
    setDraft(range)
    if (range?.from && range.to) {
      clicks.current = 0
      commit(range)
      setOpen(false)
    }
  }
  const preset = (days: number) => {
    const end = new Date()
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1))
    clicks.current = 0
    commit({ from: start, to: end })
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
        disabled={!hydrated}
        render={<FacetButton title={label} icon={<CalendarIcon />} selected={from ? [rangeLabel(current?.from, current?.to)] : []} testId="date-range" />}
      />
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar mode="range" numberOfMonths={2} defaultMonth={draft?.from ?? current?.from} selected={draft} onSelect={select} disabled={{ after: new Date() }} />
        <div className="flex flex-wrap items-center gap-1 border-t p-2">
          {PRESETS.map((p) => (
            <Button key={p.days} variant="ghost" size="sm" onClick={() => preset(p.days)}>
              {p.label}
            </Button>
          ))}
          {from && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                clicks.current = 0
                onChange({ from: undefined, to: undefined })
                setOpen(false)
              }}
            >
              Clear dates
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Rows per page for the pager. */
export function PageSizeMenu({ value, onChange }: { value: PageSize; onChange: (value: PageSize) => void }) {
  const hydrated = useHydrated()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={!hydrated}
        render={
          <Button variant="outline" size="sm" aria-label={`Rows per page: ${value}`}>
            {value} rows
            <ChevronDownIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Rows per page</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={String(value)} onValueChange={(next) => onChange(Number(next) as PageSize)}>
            {PAGE_SIZES.map((size) => (
              <DropdownMenuRadioItem key={size} value={String(size)}>
                {size}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
