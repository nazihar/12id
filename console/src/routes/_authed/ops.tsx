import { createFileRoute, redirect } from '@tanstack/react-router'

// Operator area. The navigation lives in the shell (components/shell/use-shell-model.ts).
export const Route = createFileRoute('/_authed/ops')({
  beforeLoad: ({ context }) => {
    if (!context.viewer.isOperator) throw redirect({ to: '/account' })
  },
})
