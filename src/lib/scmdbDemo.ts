import bundled from '../data/scmdbHauls.json'
import {
  createMission,
  formatDemoMissionCode,
  normalizeCrateSize,
} from './spread'
import {
  inferHaulType,
  MAX_HAUL_STOPS,
  parseHaulRank,
  parseHaulType,
} from './haulTypes'
import { ensureLocation } from '../store/catalog'
import type { HaulType, Mission } from '../types'
import { createDemoMission } from '../data/demoMissions'

export interface ScmdbHaulTemplate {
  id: string
  debugName: string
  title: string
  giver?: string
  rewardAuec: number
  commodity: string
  minScu: number
  maxScu: number
  maxUnitScu: number
  pickupPool: string[]
  dropoffPool: string[]
  multi: 'pickup' | 'dropoff' | 'single'
  haulHint?: string
  illegal?: boolean
}

interface ScmdbHaulCatalog {
  version: string
  generatedAt: string
  count: number
  /** Active hauling contractors from SCMDB contracts with haulingOrders */
  givers: string[]
  hauls: ScmdbHaulTemplate[]
}

const CACHE_KEY = 'sc-hauling-scmdb-hauls-v1'
const REFRESHED_AT_KEY = 'sc-hauling-scmdb-refreshed-at'
/** Local wall-clock hours when SCMDB is auto-refreshed. */
export const SCMDB_REFRESH_HOURS = [0, 6, 12, 18] as const

let catalog: ScmdbHaulCatalog | null = null
let refreshPromise: Promise<ScmdbHaulCatalog> | null = null

function deriveGivers(hauls: ScmdbHaulTemplate[], explicit?: unknown): string[] {
  if (Array.isArray(explicit) && explicit.length) {
    return [
      ...new Set(
        explicit
          .filter((g): g is string => typeof g === 'string' && Boolean(g.trim()))
          .map((g) => g.trim()),
      ),
    ].sort((a, b) => a.localeCompare(b))
  }
  const names = new Set<string>()
  for (const h of hauls) {
    if (h.giver?.trim()) names.add(h.giver.trim())
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

function asCatalog(raw: unknown): ScmdbHaulCatalog | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Partial<ScmdbHaulCatalog>
  if (!Array.isArray(c.hauls) || !c.hauls.length) return null
  const hauls = c.hauls as ScmdbHaulTemplate[]
  return {
    version: String(c.version || 'bundled'),
    generatedAt: String(c.generatedAt || ''),
    count: hauls.length,
    givers: deriveGivers(hauls, c.givers),
    hauls,
  }
}

function readCache(): ScmdbHaulCatalog | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return asCatalog(JSON.parse(raw))
  } catch {
    return null
  }
}

function writeCache(c: ScmdbHaulCatalog): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c))
    localStorage.setItem(REFRESHED_AT_KEY, String(Date.now()))
  } catch {
    // Quota / private mode — keep in-memory only
  }
}

function getRefreshedAt(): number {
  const n = Number(localStorage.getItem(REFRESHED_AT_KEY) || 0)
  return Number.isFinite(n) ? n : 0
}

/** Most recent 00/06/12/18 slot at or before `now` (local time). */
export function lastScmdbRefreshSlot(now = new Date()): Date {
  const d = new Date(now)
  for (let i = SCMDB_REFRESH_HOURS.length - 1; i >= 0; i--) {
    d.setHours(SCMDB_REFRESH_HOURS[i], 0, 0, 0)
    if (d.getTime() <= now.getTime()) return new Date(d)
  }
  d.setDate(d.getDate() - 1)
  d.setHours(SCMDB_REFRESH_HOURS[SCMDB_REFRESH_HOURS.length - 1], 0, 0, 0)
  return d
}

/** Next 00/06/12/18 slot strictly after `now`. */
export function nextScmdbRefreshSlot(now = new Date()): Date {
  for (let day = 0; day <= 1; day++) {
    for (const hour of SCMDB_REFRESH_HOURS) {
      const t = new Date(now)
      t.setDate(t.getDate() + day)
      t.setHours(hour, 0, 0, 0)
      if (t.getTime() > now.getTime()) return t
    }
  }
  const fallback = new Date(now)
  fallback.setDate(fallback.getDate() + 1)
  fallback.setHours(0, 0, 0, 0)
  return fallback
}

function emptyCatalog(): ScmdbHaulCatalog {
  return { version: 'empty', generatedAt: '', count: 0, givers: [], hauls: [] }
}

/** Active mission givers from SCMDB hauling contracts. */
export function listScmdbGivers(): string[] {
  return loadScmdbHaulCatalog().givers
}

/**
 * Load cached / bundled SCMDB hauls only — never hits the network.
 * Live updates go through {@link refreshScmdbHaulCatalog}.
 */
export function loadScmdbHaulCatalog(): ScmdbHaulCatalog {
  if (catalog) return catalog
  catalog = readCache() ?? asCatalog(bundled) ?? emptyCatalog()
  return catalog
}

/** Fetch latest SCMDB dump (via Vite proxy), filter, and persist. */
export async function refreshScmdbHaulCatalog(): Promise<ScmdbHaulCatalog> {
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    try {
      const versionsRes = await fetch('/scmdb-data/versions.json', {
        headers: { Accept: 'application/json' },
      })
      if (!versionsRes.ok) throw new Error(`SCMDB versions ${versionsRes.status}`)
      const versions = (await versionsRes.json()) as Array<{ version: string; file: string }>
      const latest = versions?.[0]
      if (!latest?.file) throw new Error('No SCMDB version listed')

      const dataRes = await fetch(`/scmdb-data/${latest.file}`, {
        headers: { Accept: 'application/json' },
      })
      if (!dataRes.ok) throw new Error(`SCMDB dump ${dataRes.status}`)
      const data = await dataRes.json()
      const built = buildCatalogFromMerged(data, latest.version)
      if (!built.hauls.length) throw new Error('SCMDB haul filter returned empty')

      catalog = built
      writeCache(built)
      return built
    } catch (err) {
      // Keep prior cache / bundle; still stamp attempt time only on success
      if (!catalog) catalog = loadScmdbHaulCatalog()
      throw err
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

/**
 * Auto-refresh at 00:00 / 06:00 / 12:00 / 18:00 local time.
 * Also catches up once if the last successful refresh is older than the
 * most recent slot (e.g. app was closed over a boundary).
 * Returns a dispose function.
 */
export function startScmdbRefreshSchedule(onRefreshed?: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  const run = async () => {
    if (cancelled) return
    try {
      await refreshScmdbHaulCatalog()
      onRefreshed?.()
    } catch {
      // Soft-fail — Demo keeps using cache/bundle
    }
  }

  const scheduleNext = () => {
    if (cancelled) return
    const delay = Math.max(1000, nextScmdbRefreshSlot().getTime() - Date.now())
    timer = setTimeout(() => {
      void run().finally(scheduleNext)
    }, delay)
  }

  // Catch-up only if we previously refreshed and missed a later slot while closed.
  // First visit uses the bundle until Refresh data or the next 00/06/12/18 slot.
  const refreshedAt = getRefreshedAt()
  const lastSlot = lastScmdbRefreshSlot().getTime()
  if (refreshedAt > 0 && refreshedAt < lastSlot) {
    void run().finally(scheduleNext)
  } else {
    scheduleNext()
  }

  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}

/** Same filtering as scripts/fetch-scmdb-hauls.mjs (kept in sync for live proxy). */
function buildCatalogFromMerged(data: Record<string, unknown>, version: string): ScmdbHaulCatalog {
  // Dynamic import of filter would duplicate — reuse bundled if live parse is heavy.
  // For live path, re-run a lightweight filter inline matching the script.
  const pools = (data.locationPools || {}) as Record<
    string,
    { name?: string; type?: string }
  >
  const resources = (data.resourcePools || {}) as Record<string, { name?: string }>
  const contracts = (data.contracts || []) as Array<Record<string, unknown>>
  const SKIP = new Set(['Star', 'Planet', 'Moon', 'Default'])

  const isStop = (p?: { name?: string; type?: string }) =>
    Boolean(p?.name && !String(p.name).startsWith('@') && !SKIP.has(p.type || '') && !/^Outpost /i.test(p.name))

  const resolve = (ids: unknown) => {
    const names: string[] = []
    const seen = new Set<string>()
    for (const id of (ids as string[]) || []) {
      const p = pools[id]
      if (!isStop(p)) continue
      const n = String(p.name).trim()
      const k = n.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      names.push(n)
    }
    return names
  }

  const giverNames = new Set<string>()
  const hauls: ScmdbHaulTemplate[] = []
  for (const c of contracts) {
    const ordersRaw = c.haulingOrders as
      | Array<{
          resource?: string
          minSCU?: number
          maxSCU?: number
          minAmount?: number
          maxAmount?: number
          maxContainerSize?: number
        }>
      | undefined
    if (!ordersRaw?.length) continue

    if (typeof c.contractorName === 'string' && c.contractorName.trim()) {
      giverNames.add(c.contractorName.trim())
    }

    const pick = new Set(resolve(c.locations))
    const drop = new Set(resolve(c.destinations))
    for (const set of (c.locationSets as Array<{ locations?: string[]; destinations?: string[] }>) || []) {
      for (const n of resolve(set.locations)) pick.add(n)
      for (const n of resolve(set.destinations)) drop.add(n)
    }
    if (!pick.size && drop.size >= 2) {
      const all = [...drop]
      const debug = String(c.debugName || '')
      const named =
        all.find((n) => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(debug)) ||
        all.find((n) => /Ruin/i.test(n)) ||
        all[0]
      pick.add(named)
      drop.delete(named)
    }
    const pickupPool = [...pick]
    const dropoffPool = [...drop]
    if (!pickupPool.length || !dropoffPool.length) continue

    const byCommodity = new Map<
      string,
      { commodity: string; minSCU: number; maxSCU: number; maxUnit: number }
    >()
    for (const o of ordersRaw) {
      const commodity = resources[o.resource || '']?.name
      if (!commodity || /PLACEHOLDER/i.test(commodity)) continue
      const minSCU = Number(o.minSCU ?? o.minAmount ?? 0) || 0
      const maxSCU = Number(o.maxSCU ?? o.maxAmount ?? 0) || 0
      const maxUnit = Number(o.maxContainerSize ?? 0) || 0
      if (!minSCU && !maxSCU) continue
      const prev = byCommodity.get(commodity)
      if (!prev) byCommodity.set(commodity, { commodity, minSCU, maxSCU, maxUnit })
      else {
        prev.minSCU = Math.max(prev.minSCU, minSCU)
        prev.maxSCU = Math.max(prev.maxSCU, maxSCU)
        prev.maxUnit = Math.max(prev.maxUnit, maxUnit)
      }
    }
    const uniq = [...byCommodity.values()]
    if (!uniq.length) continue

    const minScu = Math.max(
      1,
      uniq.reduce((s, o) => s + o.minSCU, 0),
    )
    const maxScu = Math.max(
      1,
      uniq.reduce((s, o) => s + (o.maxSCU || o.minSCU), 0),
    )
    const maxUnitScu = Math.max(...uniq.map((o) => o.maxUnit || 1), 1)
    const commodity =
      uniq.length === 1 ? uniq[0].commodity : uniq.map((o) => o.commodity).join(' / ')

    let title = String(c.title || c.debugName || 'Haul')
    title = title
      .replace(/\[DESTINATION\]/gi, dropoffPool[0])
      .replace(/\[LOCATION\]/gi, pickupPool[0])
      .replace(/\[TARGET\]/gi, pickupPool[0])

    const debugName = String(c.debugName || '')
    const multi: ScmdbHaulTemplate['multi'] = /SingleToMulti/i.test(debugName)
      ? 'dropoff'
      : /Multi\d*ToSingle|MultiToSingle/i.test(debugName)
        ? 'pickup'
        : 'single'

    hauls.push({
      id: String(c.id || debugName),
      debugName,
      title,
      giver: typeof c.contractorName === 'string' ? c.contractorName : undefined,
      rewardAuec: Number(c.rewardUEC) || 0,
      commodity,
      minScu,
      maxScu,
      maxUnitScu,
      pickupPool,
      dropoffPool,
      multi,
      illegal: Boolean(c.illegal),
    })
  }

  return {
    version: String(data.version || version),
    generatedAt: new Date().toISOString(),
    count: hauls.length,
    givers: [...giverNames].sort((a, b) => a.localeCompare(b)),
    hauls,
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function pickN(pool: string[], n: number, exclude: Set<string> = new Set()): string[] {
  const avail = shuffle(pool.filter((p) => !exclude.has(p.toLowerCase())))
  return avail.slice(0, Math.max(0, n))
}

function rollScu(min: number, max: number): number {
  const lo = Math.max(1, Math.round(min))
  const hi = Math.max(lo, Math.round(max || min))
  if (hi === lo) return lo
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

function resolveNames(names: string[]): string[] {
  return names.map((n) => ensureLocation(n).id)
}

/**
 * Build one demo mission from SCMDB catalog entry `index` (wraps).
 * Falls back to hardcoded Red Wind samples if catalog is empty.
 */
export function createScmdbDemoMission(
  catalogHauls: ScmdbHaulTemplate[],
  index: number,
  code?: string,
): Mission {
  if (!catalogHauls.length) {
    return createDemoMission(index, code)
  }
  const t = catalogHauls[((index % catalogHauls.length) + catalogHauls.length) % catalogHauls.length]

  const exclude = new Set<string>()
  let pickupNames: string[]
  let dropoffNames: string[]

  if (t.multi === 'pickup') {
    dropoffNames = pickN(t.dropoffPool, 1)
    dropoffNames.forEach((n) => exclude.add(n.toLowerCase()))
    const n = Math.min(MAX_HAUL_STOPS, Math.max(2, Math.min(4, t.pickupPool.length)))
    pickupNames = pickN(t.pickupPool, n, exclude)
    if (!pickupNames.length) pickupNames = pickN(t.pickupPool, 1)
  } else if (t.multi === 'dropoff') {
    pickupNames = pickN(t.pickupPool, 1)
    pickupNames.forEach((n) => exclude.add(n.toLowerCase()))
    const n = Math.min(MAX_HAUL_STOPS, Math.max(2, Math.min(4, t.dropoffPool.length)))
    dropoffNames = pickN(t.dropoffPool, n, exclude)
    if (!dropoffNames.length) dropoffNames = pickN(t.dropoffPool, 1)
  } else {
    pickupNames = pickN(t.pickupPool, 1)
    pickupNames.forEach((n) => exclude.add(n.toLowerCase()))
    dropoffNames = pickN(t.dropoffPool, 1, exclude)
    if (!dropoffNames.length) dropoffNames = pickN(t.dropoffPool, 1)
  }

  // Guarantee at least one each
  if (!pickupNames.length) pickupNames = [t.pickupPool[0]]
  if (!dropoffNames.length) dropoffNames = [t.dropoffPool[0]]

  const pickupIds = resolveNames(pickupNames)
  const dropoffIds = resolveNames(dropoffNames)
  const totalScu = rollScu(t.minScu, t.maxScu)
  const maxUnitScu = normalizeCrateSize(t.maxUnitScu || 8)
  const haulType: HaulType =
    (t.haulHint && parseHaulType(t.haulHint)) ||
    parseHaulType(t.title) ||
    inferHaulType(pickupIds.length, dropoffIds.length, t.title)

  const name = `(DEMO) ${t.title}`.replace(/^\(DEMO\)\s*\(DEMO\)/i, '(DEMO)')

  return createMission({
    code: code ?? formatDemoMissionCode((index % catalogHauls.length) + 1),
    name,
    haulType,
    rank: parseHaulRank(t.title),
    giver: t.giver,
    commodity: t.commodity,
    totalScu,
    maxUnitScu,
    rewardAuec: t.rewardAuec || undefined,
    pickupIds,
    dropoffIds,
    source: 'demo',
  })
}

