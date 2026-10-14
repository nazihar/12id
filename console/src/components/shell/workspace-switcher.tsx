import { useQuery } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { BuildingIcon, CheckIcon, ChevronsUpDownIcon, type LucideIcon, ShieldUserIcon } from 'lucide-react'

import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { myOrganizationsQuery } from '@/features/portal/portal.queries'

import type { Workspace } from './use-shell-model'

/** Top item of the sidebar: the current workspace, and a menu to switch to the operator console or another organization. */
export function WorkspaceSwitcher({ workspace }: { workspace: Workspace }) {
  const { viewer } = useRouteContext({ from: '/_authed' })
  const { isMobile } = useSidebar()
  const { data: organizations = [] } = useQuery(myOrganizationsQuery())
  const Icon = workspace.kind === 'ops' ? ShieldUserIcon : BuildingIcon
  const subtitle = workspace.kind === 'organization' ? workspace.roleLabel : workspace.kind === 'ops' ? 'all tenants' : 'signed in'

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground" aria-label="Switch workspace">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Icon className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{workspace.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
                </div>
                <ChevronsUpDownIcon className="ml-auto size-4" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent className="w-(--anchor-width) min-w-56" align="start" side={isMobile ? 'bottom' : 'right'} sideOffset={4}>
            {viewer.isStaff && (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Platform</DropdownMenuLabel>
                  <WorkspaceItem icon={ShieldUserIcon} name="Operator console" detail="all tenants" current={workspace.kind === 'ops'} to="/ops" />
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {organizations.length === 0 && <DropdownMenuItem disabled>No organizations yet</DropdownMenuItem>}
              {organizations.filter((organization) => !organization.disabled).map((organization) => (
                <WorkspaceItem
                  key={organization.id}
                  icon={BuildingIcon}
                  name={organization.name}
                  detail={organization.roleLabel}
                  current={workspace.kind === 'organization' && workspace.slug === organization.slug}
                  to="/t/$orgSlug"
                  params={{ orgSlug: organization.slug }}
                />
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/account" />}>All organizations</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/**
 * One workspace in the menu. The current one is marked by a tick in a fixed slot, so every row's
 * name and role line up whether or not it is the current workspace.
 */
function WorkspaceItem({
  icon: Icon,
  name,
  detail,
  current,
  to,
  params,
}: {
  icon: LucideIcon
  name: string
  detail: string
  current: boolean
  to: string
  params?: Record<string, string>
}) {
  return (
    <DropdownMenuItem render={<Link to={to} params={params} />} className="gap-2 py-1.5" aria-current={current ? 'page' : undefined}>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-3.5" />
      </span>
      <span className="grid min-w-0 flex-1 leading-tight">
        <span className="truncate">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      <span className="flex size-4 shrink-0 items-center justify-center">{current && <CheckIcon className="size-4" />}</span>
    </DropdownMenuItem>
  )
}
