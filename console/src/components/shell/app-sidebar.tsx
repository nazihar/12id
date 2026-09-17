import { Link } from '@tanstack/react-router'

import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'

import type { ShellModel } from './use-shell-model'
import { WorkspaceSwitcher } from './workspace-switcher'

export function AppSidebar({ model }: { model: ShellModel }) {
  // On a phone the sidebar is a sheet over the page: choosing a page has to close it.
  const { isMobile, setOpenMobile } = useSidebar()
  const closeOnMobile = () => isMobile && setOpenMobile(false)
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <WorkspaceSwitcher workspace={model.workspace} />
      </SidebarHeader>
      <SidebarContent>
        {model.groups.map((group) => (
          <SidebarGroup key={group.ariaLabel}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <nav aria-label={group.ariaLabel}>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton isActive={model.isActive(item)} tooltip={item.label} onClick={closeOnMobile} render={<Link to={item.to} params={item.params} />}>
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
