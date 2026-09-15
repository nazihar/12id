import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/t/$orgSlug/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/t/$orgSlug/catalogue', params })
  },
})
