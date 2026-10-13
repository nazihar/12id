import type { ReactNode } from 'react'

import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'

import { AppHeader } from './app-header'
import { AppSidebar } from './app-sidebar'
import { IdleGuard } from './idle-guard'
import { useShellModel } from './use-shell-model'

/** Sidebar + header around every signed-in page. Mounted once, in the `_authed` layout. */
export function AppShell({ sidebarOpen, children }: { sidebarOpen: boolean; children: ReactNode }) {
  const model = useShellModel()
  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AppSidebar model={model} />
      <IdleGuard />
      {/* `min-w-0`: a flex child sizes to its content by default, so one wide table would stretch the
          whole page and scroll the window sideways. The page keeps the window's width and wide content
          scrolls inside itself. */}
      <SidebarInset className="min-w-0">
        <AppHeader crumbs={model.crumbs} />
        <div className="flex w-full min-w-0 flex-1 flex-col gap-6 p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
