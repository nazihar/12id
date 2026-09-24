import { tableFeatures } from '@tanstack/react-table'

// The features every console table registers (TanStack Table v9 opts in per feature). Since C9 the
// server pages, searches and filters, and the order is fixed (newest first), so only the core row
// model is needed. One module, so column helpers and DataTable agree on the type.
export const features = tableFeatures({})

export type DataTableFeatures = typeof features
