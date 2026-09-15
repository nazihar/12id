/**
 * Better Auth client for the browser: sign-in, 2FA, organization switching. Data never flows
 * through it; tenant data comes from server functions only.
 */
import { adminClient, inferOrgAdditionalFields, organizationClient, twoFactorClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

import type { auth } from '../server/auth.server'
import { platformAc, platformRoles, tenantAc, tenantRoles } from './permissions'

export const authClient = createAuthClient({
  plugins: [
    organizationClient({ ac: tenantAc, roles: tenantRoles, schema: inferOrgAdditionalFields<typeof auth>() }),
    twoFactorClient({ twoFactorPage: '/verify-2fa' }),
    adminClient({ ac: platformAc, roles: platformRoles }),
  ],
})
