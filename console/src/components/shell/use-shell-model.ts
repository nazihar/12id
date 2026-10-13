/**
 * What the shell shows for the current location: the workspace (operator console, one organization,
 * or the account page), the sidebar groups and the breadcrumb. Derived from the matched routes, so
 * every area declares its navigation here and nowhere else.
 */
import { useQuery } from '@tanstack/react-query'
import { useMatchRoute, useMatches, useRouteContext } from '@tanstack/react-router'
import { ActivityIcon, BuildingIcon, CheckCheckIcon, ChartColumnIcon, FileBadgeIcon, GlobeIcon, KeyRoundIcon, LayoutDashboardIcon, type LucideIcon, ScanFaceIcon, ScrollTextIcon, ShieldCheckIcon, ShieldUserIcon, SmartphoneIcon, UsersIcon, WalletIcon, WebhookIcon } from 'lucide-react'

import { opsOpenChangesQuery, portalOpenChangesQuery } from '@/features/approvals/approvals.queries'
import type { TenantRole } from '@/lib/permissions'

export interface NavItem {
  label: string
  to: string
  params?: Record<string, string>
  icon: LucideIcon
  /** Only the exact path counts as active (index routes). */
  exact?: boolean
  /** A count shown beside the label when it is above zero (what waits for approval). */
  badge?: number
}

export interface NavGroup {
  label: string
  /** Accessible name of the group's `<nav>`. */
  ariaLabel: string
  items: NavItem[]
}

export type Workspace = { kind: 'ops'; name: string; to: string } | { kind: 'organization'; name: string; slug: string; role: TenantRole; to: string; params: Record<string, string> } | { kind: 'account'; name: string; to: string }

export interface Crumb {
  label: string
  to?: string
  params?: Record<string, string>
}

export interface ShellModel {
  workspace: Workspace
  groups: NavGroup[]
  crumbs: Crumb[]
  isActive: (item: NavItem) => boolean
}

const OPS_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/ops', icon: LayoutDashboardIcon, exact: true },
  { label: 'Tenants', to: '/ops/tenants', icon: BuildingIcon },
  { label: 'Dead deliveries', to: '/ops/deliveries', icon: WebhookIcon },
  { label: 'Audit log', to: '/ops/audit', icon: ScrollTextIcon },
  { label: 'System health', to: '/ops/health', icon: ActivityIcon },
  { label: 'Approvals', to: '/ops/approvals', icon: CheckCheckIcon },
  { label: 'Operators', to: '/ops/operators', icon: ShieldUserIcon },
]

function tenantItems(tenantId: string): NavItem[] {
  const params = { tenantId }
  return [
    { label: 'Overview', to: '/ops/tenants/$tenantId', params, icon: LayoutDashboardIcon, exact: true },
    { label: 'API keys', to: '/ops/tenants/$tenantId/api-keys', params, icon: KeyRoundIcon },
    { label: 'Catalogue', to: '/ops/tenants/$tenantId/catalogue', params, icon: FileBadgeIcon },
    { label: 'Proof templates', to: '/ops/tenants/$tenantId/templates', params, icon: ScrollTextIcon },
    { label: 'Wallets', to: '/ops/tenants/$tenantId/wallets', params, icon: WalletIcon },
    { label: 'Exchanges', to: '/ops/tenants/$tenantId/exchanges', params, icon: GlobeIcon },
    { label: 'Verification', to: '/ops/tenants/$tenantId/verification', params, icon: ChartColumnIcon },
    { label: 'Webhooks', to: '/ops/tenants/$tenantId/webhooks', params, icon: WebhookIcon },
    { label: 'Biometrics', to: '/ops/tenants/$tenantId/biometrics', params, icon: ScanFaceIcon },
    { label: 'Data protection', to: '/ops/tenants/$tenantId/data-protection', params, icon: ShieldCheckIcon },
    { label: 'Approvals', to: '/ops/tenants/$tenantId/approvals', params, icon: CheckCheckIcon },
  ]
}

function portalItems(orgSlug: string): NavItem[] {
  const params = { orgSlug }
  return [
    { label: 'Overview', to: '/t/$orgSlug', params, icon: LayoutDashboardIcon, exact: true },
    { label: 'Catalogue', to: '/t/$orgSlug/catalogue', params, icon: FileBadgeIcon },
    { label: 'Proof templates', to: '/t/$orgSlug/templates', params, icon: ScrollTextIcon },
    { label: 'Wallets', to: '/t/$orgSlug/wallets', params, icon: SmartphoneIcon },
    { label: 'Exchanges', to: '/t/$orgSlug/exchanges', params, icon: GlobeIcon },
    { label: 'Verification', to: '/t/$orgSlug/verification', params, icon: ChartColumnIcon },
    { label: 'Webhooks', to: '/t/$orgSlug/webhooks', params, icon: WebhookIcon },
    { label: 'Biometrics', to: '/t/$orgSlug/biometrics', params, icon: ScanFaceIcon },
    { label: 'Data protection', to: '/t/$orgSlug/data-protection', params, icon: ShieldCheckIcon },
    { label: 'API keys', to: '/t/$orgSlug/api-keys', params, icon: KeyRoundIcon },
    { label: 'Members', to: '/t/$orgSlug/members', params, icon: UsersIcon },
    { label: 'Approvals', to: '/t/$orgSlug/approvals', params, icon: CheckCheckIcon },
  ]
}

export function useShellModel(): ShellModel {
  const matches = useMatches()
  const matchRoute = useMatchRoute()
  const { viewer } = useRouteContext({ from: '/_authed' })
  const isActive = (item: NavItem) => Boolean(matchRoute({ to: item.to, params: item.params, fuzzy: !item.exact }))
  const activeLabel = (items: NavItem[]) => items.find(isActive)?.label

  const portal = matches.find((match) => match.routeId === '/_authed/t/$orgSlug')
  const opsMatch = matches.find((match) => match.routeId === '/_authed/ops')
  const opsTenantId = (matches.find((match) => match.routeId === '/_authed/ops/tenants/$tenantId')?.params as { tenantId?: string } | undefined)?.tenantId
  const portalSlug = (portal?.params as { orgSlug?: string } | undefined)?.orgSlug
  // What waits for a second person (implement/22 C19), beside each Approvals entry. The queries run
  // in the browser after the page is there, so a slow or failing count never holds the shell up.
  const portalOpen = useQuery({ ...portalOpenChangesQuery(portalSlug ?? ''), enabled: Boolean(portal && portalSlug) })
  const operatorsOpen = useQuery({ ...opsOpenChangesQuery(), enabled: Boolean(opsMatch) })
  const tenantOpen = useQuery({ ...opsOpenChangesQuery(opsTenantId), enabled: Boolean(opsMatch && opsTenantId) })
  const withCount = (items: NavItem[], count: number | undefined) => items.map((item) => (item.label === 'Approvals' ? { ...item, badge: count } : item))
  // A refused organization (beforeLoad threw) still matches, without an organization in its context.
  const organization = (portal?.context as { organization?: { name: string; slug: string; role: TenantRole } } | undefined)?.organization
  if (portal && organization) {
    const items = withCount(portalItems(organization.slug), portalOpen.data?.total)
    const params = { orgSlug: organization.slug }
    const workspace: Workspace = { kind: 'organization', name: organization.name, slug: organization.slug, role: organization.role, to: '/t/$orgSlug', params }
    const page = activeLabel(items)
    return {
      workspace,
      groups: [{ label: organization.name, ariaLabel: 'Organization sections', items }],
      crumbs: [{ label: organization.name, to: '/t/$orgSlug', params }, ...(page && page !== 'Overview' ? [{ label: page }] : [])],
      isActive,
    }
  }

  const ops = matches.find((match) => match.routeId === '/_authed/ops')
  if (ops) {
    const workspace: Workspace = { kind: 'ops', name: 'Operator console', to: '/ops' }
    const opsItems = withCount(OPS_ITEMS, operatorsOpen.data?.total)
    const groups: NavGroup[] = [{ label: 'Operator console', ariaLabel: 'Operator sections', items: opsItems }]
    const crumbs: Crumb[] = [{ label: 'Operator console', to: '/ops' }]
    const tenantMatch = matches.find((match) => match.routeId === '/_authed/ops/tenants/$tenantId')
    if (tenantMatch) {
      const tenantId = (tenantMatch.params as { tenantId: string }).tenantId
      const tenant = tenantMatch.loaderData as { name?: string } | undefined
      const items = withCount(tenantItems(tenantId), tenantOpen.data?.total)
      groups.push({ label: `Tenant · ${tenant?.name ?? tenantId.slice(0, 8)}`, ariaLabel: 'Tenant sections', items })
      crumbs.push({ label: 'Tenants', to: '/ops/tenants' }, { label: tenant?.name ?? tenantId.slice(0, 8), to: '/ops/tenants/$tenantId', params: { tenantId } })
      const page = activeLabel(items)
      if (page && page !== 'Overview') crumbs.push({ label: page })
    } else {
      const page = activeLabel(OPS_ITEMS)
      if (page && page !== 'Dashboard') crumbs.push({ label: page })
    }
    return { workspace, groups, crumbs, isActive }
  }

  const items: NavItem[] = [{ label: 'Your organizations', to: '/account', icon: BuildingIcon, exact: true }]
  return {
    workspace: { kind: 'account', name: viewer.name || viewer.email, to: '/account' },
    groups: [{ label: 'Account', ariaLabel: 'Account sections', items }],
    crumbs: [{ label: 'Your organizations' }],
    isActive,
  }
}
