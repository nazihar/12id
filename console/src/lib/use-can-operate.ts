import { useRouteContext } from '@tanstack/react-router'

/**
 * false for an auditor (implement/22-console-feedback.md C14). The operator area shows an auditor
 * every page and offers no change: the server functions and platform-api refuse them anyway, so a
 * button would only lead to an error.
 */
export const useCanOperate = () => useRouteContext({ from: '/_authed' }).viewer.isOperator
