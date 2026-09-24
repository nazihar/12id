import { useRouterState } from '@tanstack/react-router'

/**
 * True while the router loads the next page of a list (a search change re-runs the route loader,
 * which keeps the current rows on screen until the new page is in the cache).
 */
export const useListPending = () => useRouterState({ select: (state) => state.isLoading })
