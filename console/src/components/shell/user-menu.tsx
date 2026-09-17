import { Link, useHydrated, useRouteContext, useRouter } from '@tanstack/react-router'
import { BuildingIcon, LogOutIcon, ShieldUserIcon } from 'lucide-react'

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { authClient } from '@/lib/auth-client'

export function initials(name: string, email: string) {
  const source = name.trim() || email
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  return parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}`.toUpperCase() : source.slice(0, 2).toUpperCase()
}

/** Profile button in the header: who is signed in, where else they can go, and sign out. */
export function UserMenu() {
  const { viewer } = useRouteContext({ from: '/_authed' })
  const router = useRouter()
  // A click before hydration would do nothing; the trigger waits for the handlers.
  const hydrated = useHydrated()

  async function signOut() {
    await authClient.signOut()
    await router.invalidate()
    await router.navigate({ to: '/login' })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={!hydrated}
        render={
          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Account menu">
            <Avatar size="sm">
              <AvatarFallback>{initials(viewer.name, viewer.email)}</AvatarFallback>
            </Avatar>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="grid text-sm leading-tight">
              <span className="truncate font-medium">{viewer.name || viewer.email}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">{viewer.email}</span>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/account" />}>
            <BuildingIcon />
            Your organizations
          </DropdownMenuItem>
          {viewer.isOperator && (
            <DropdownMenuItem render={<Link to="/ops" />}>
              <ShieldUserIcon />
              Operator console
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
