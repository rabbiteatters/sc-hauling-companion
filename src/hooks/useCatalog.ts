import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  getCatalog,
  loadCatalog,
  subscribeCatalog,
  type CatalogState,
} from '../store/catalog'

export function useCatalog(): CatalogState & { reload: () => Promise<void> } {
  const state = useSyncExternalStore(subscribeCatalog, getCatalog, getCatalog)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!state.loadedAt && !state.loading) {
      void loadCatalog().catch(() => setTick((t) => t + 1))
    }
  }, [state.loadedAt, state.loading])

  return {
    ...state,
    /** Refresh data — reloads UEX catalog and SCMDB demo hauls. */
    reload: () => loadCatalog({ refreshScmdb: true }),
  }
}
