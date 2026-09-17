import { Link } from '@tanstack/react-router'
import { Fragment } from 'react'

import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'

import { ThemeToggle } from './theme-toggle'
import type { Crumb } from './use-shell-model'
import { UserMenu } from './user-menu'

export function AppHeader({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-backdrop-filter:bg-background/80">
      <SidebarTrigger className="-ml-1" />
      {/* Base UI marks the orientation as `data-vertical`, and the component's own classes stretch it. */}
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1
            return (
              <Fragment key={`${crumb.label}-${index}`}>
                {index > 0 && <BreadcrumbSeparator className={index === 1 ? 'hidden sm:block' : undefined} />}
                <BreadcrumbItem className={index === 0 && !last ? 'hidden sm:inline-flex' : undefined}>
                  {last || !crumb.to ? <BreadcrumbPage>{crumb.label}</BreadcrumbPage> : <BreadcrumbLink render={<Link to={crumb.to} params={crumb.params} />}>{crumb.label}</BreadcrumbLink>}
                </BreadcrumbItem>
              </Fragment>
            )
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  )
}
