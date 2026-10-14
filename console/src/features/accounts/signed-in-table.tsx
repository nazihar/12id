/** Who is signed in now (implement/26, MTB 6.106): one row per live session, newest activity first. */
import { createColumnHelper } from '@tanstack/react-table'
import { LogOutIcon } from 'lucide-react'

import { DataTable } from '@/components/data-table/data-table'
import type { DataTableFeatures } from '@/components/data-table/data-table-features'
import { RowAction, RowActions } from '@/components/row-action'
import { formatDateTime } from '@/lib/format'

export interface LiveSessionRow {
  sessionId: string
  userId: string
  name: string
  email: string
  role: string
  signedInAt: string
  lastActiveAt: string
  ipAddress: string | null
  userAgent: string | null
}

const column = createColumnHelper<DataTableFeatures, LiveSessionRow>()

/** The browser and system in a few words, from the user agent. */
export function browserOf(userAgent: string | null) {
  if (!userAgent) return 'unknown'
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser'
  const system = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : ''
  return system ? `${browser} on ${system}` : browser
}

/** `onEnd`: who may end a session (operators); without it the list is read-only. `currentUserId` is never offered. */
export function SignedInTable({ rows, roleLabel = (role) => role, currentUserId, onEnd }: { rows: LiveSessionRow[]; roleLabel?: (role: string) => string; currentUserId: string; onEnd?: (row: LiveSessionRow) => Promise<unknown> }) {
  const columns = column.columns([
    column.accessor('name', { header: 'Name', cell: ({ row }) => `${row.original.name}${row.original.userId === currentUserId ? ' (you)' : ''}` }),
    column.accessor('email', { header: 'Email' }),
    column.accessor('role', { header: 'Role', cell: ({ getValue }) => roleLabel(getValue()) }),
    column.accessor('signedInAt', { header: 'Signed in', cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.accessor('lastActiveAt', { header: 'Last active', cell: ({ getValue }) => formatDateTime(getValue()) }),
    column.accessor('ipAddress', { header: 'Address', cell: ({ getValue }) => getValue() ?? 'unknown' }),
    column.accessor('userAgent', { header: 'Browser', cell: ({ getValue }) => browserOf(getValue()) }),
    column.display({
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        onEnd && row.original.userId !== currentUserId ? (
          <RowActions>
            <RowAction
              label="End session"
              icon={LogOutIcon}
              confirm={{
                title: `End the session of ${row.original.email}?`,
                description: 'They are signed out now and can sign in again with their password and second factor.',
                confirmLabel: 'End session',
                destructive: true,
                onConfirm: () => onEnd(row.original),
              }}
            />
          </RowActions>
        ) : null,
    }),
  ])
  return <DataTable columns={columns} data={rows} emptyMessage="Nobody is signed in now." testId="signed-in-table" />
}
