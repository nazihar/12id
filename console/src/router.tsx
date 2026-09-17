import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { type AnyRouter, createRouter, isRedirect } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'

import { routeTree } from './routeTree.gen'

export function getRouter() {
  // A server function whose middleware finds no usable session throws a router redirect. A loader is
  // redirected by the router itself; a query or mutation would only put the redirect in its error, so
  // the caches follow it here. Without this, an expired session leaves an error on the page with no
  // way to sign in again.
  let router: AnyRouter | null = null
  const follow = (error: unknown) => {
    if (router && isRedirect(error)) void router.navigate(router.resolveRedirect(error).options)
  }

  // A new QueryClient per router, i.e. per request on the server: cached data never crosses users.
  const queryClient = new QueryClient({
    // No `retry` default: `fetchQuery` (route loaders) sets its own `retry: false`, and overriding it
    // here would make a loader retry a refusal instead of showing it.
    defaultOptions: { queries: { staleTime: 30_000 } },
    queryCache: new QueryCache({ onError: follow }),
    mutationCache: new MutationCache({ onError: follow }),
  })
  router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}
