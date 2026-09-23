/// <reference types="vite/client" />
import type { QueryClient } from '@tanstack/react-query'
import { HeadContent, Outlet, Scripts, createRootRouteWithContext, useRouter } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import type { ReactNode } from 'react'

import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getViewer } from '@/features/session/session.functions'
import appCss from '@/styles/app.css?url'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // The viewer drives route guards (UX). Server functions re-check through their own middleware.
  beforeLoad: async () => ({ viewer: await getViewer() }),
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: '12iD' }],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  // The request's CSP nonce (start.ts, router.tsx): next-themes' inline script needs it to run.
  // Undefined in the browser, where the script has already run.
  const nonce = useRouter().options.ssr?.nonce
  return (
    // next-themes sets the `dark` class on <html> before paint from an inline script; the
    // server cannot know the choice, hence the hydration warning is suppressed on this element only.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange nonce={nonce}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}
