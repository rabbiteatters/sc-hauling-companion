import {
  buildMissionNameOptions,
  fetchCommodities,
  fetchLocations,
  fetchShips,
  type CommodityInfo,
} from '../api/uex'
import {
  locationsShareScope,
  type HaulScope,
} from '../lib/haulScope'
import { listScmdbGivers } from '../lib/scmdbDemo'
import type { Location, Ship } from '../types'

/** Already-accepted stops a new match must stay compatible with. */
export interface HaulMatchContext {
  scope: HaulScope
  anchors: Location[]
}

export interface CatalogState {
  ships: Ship[]
  locations: Location[]
  commodities: CommodityInfo[]
  givers: string[]
  missionNames: string[]
  loading: boolean
  error: string | null
  loadedAt: number | null
}

type Listener = () => void

let state: CatalogState = {
  ships: [],
  locations: [],
  commodities: [],
  givers: [],
  missionNames: [],
  loading: false,
  error: null,
  loadedAt: null,
}

const listeners = new Set<Listener>()
const customLocations = new Map<string, Location>()

function emit() {
  for (const l of listeners) l()
}

export function getCatalog(): CatalogState {
  return state
}

export function subscribeCatalog(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAllLocations(): Location[] {
  const byId = new Map(state.locations.map((l) => [l.id, l]))
  for (const c of customLocations.values()) byId.set(c.id, c)
  return [...byId.values()]
}

export function getLocation(id: string): Location | undefined {
  return customLocations.get(id) ?? state.locations.find((l) => l.id === id)
}

/**
 * Turn a saved stop id back into a catalog location.
 * Custom ids from a bad scan ("Dudiey Daughters at the") prefer the real station.
 */
export function resolveStoredLocation(id: string): Location | undefined {
  const known = getLocation(id)
  if (known && !known.id.startsWith('custom-')) return known
  const words = id
    .replace(/^custom-/, '')
    .replace(/-/g, ' ')
    .replace(/\bat the$/, '')
    .trim()
  const hit = words
    ? (findLocationByName(words) ?? matchOcrLocationName(words))
    : undefined
  if (hit && !hit.id.startsWith('custom-')) return hit
  if (known) return known
  if (!words) return undefined
  return ensureLocation(words)
}

export function locationLabel(id: string): string {
  return getLocation(id)?.shortName ?? id
}

/** Short note for route stops — UEX exterior loading dock availability. */
export function exteriorElevatorNote(locationId: string): string | null {
  const loc = getLocation(locationId)
  if (!loc || loc.hasExteriorElevator == null) return null
  return loc.hasExteriorElevator
    ? 'UEX: exterior loading dock — load/unload in zero-G'
    : 'UEX: no exterior loading dock — hangar or pad freight elevator only'
}

export function distanceBetween(a: Location, b: Location): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isGateway(loc: Location): boolean {
  return /gateway|jump\s*point/i.test(`${loc.name} ${loc.shortName} ${loc.id}`)
}

const NYX_GATEWAY_PYRO_ID = 'nyx-gateway-pyro'

/**
 * Nyx Gateway (Pyro). Used when objectives list the same collect place twice
 * (in-game hauling quirk: 2nd copy is the jump gate).
 */
export function getNyxGatewayPyro(): Location {
  const found =
    getLocation(NYX_GATEWAY_PYRO_ID) ??
    getAllLocations().find(
      (l) =>
        /nyx/i.test(l.name) &&
        /gateway|jump/i.test(`${l.name} ${l.shortName}`) &&
        (l.system === 'pyro' || /pyro/i.test(l.body)),
    ) ??
    getAllLocations().find(
      (l) => /nyx/i.test(l.name) && /gateway|jump/i.test(`${l.name} ${l.shortName}`),
    )
  if (found) {
    // UEX omits loading_dock on Pyro side; gateways have exterior elevators
    if (found.hasExteriorElevator) return found
    const withDock = { ...found, hasExteriorElevator: true }
    if (found.id === NYX_GATEWAY_PYRO_ID) customLocations.set(found.id, withDock)
    return withDock
  }

  const pyro = state.locations.filter((l) => l.system === 'pyro' && !isGateway(l))
  const pool = pyro.length ? pyro : state.locations
  const avg = pool.reduce(
    (a, l) => ({ x: a.x + l.x, y: a.y + l.y, z: a.z + l.z }),
    { x: 0, y: 0, z: 0 },
  )
  const n = Math.max(pool.length, 1)
  const loc: Location = {
    id: NYX_GATEWAY_PYRO_ID,
    name: 'Nyx Gateway',
    shortName: 'Nyx Gateway',
    body: 'Pyro',
    type: 'landing',
    system: 'pyro',
    x: avg.x / n,
    y: avg.y / n,
    z: avg.z / n,
    aliases: ['Nyx Gateway', 'Nyx Gate', 'Nyx Jump Point'],
    hasExteriorElevator: true,
  }
  customLocations.set(loc.id, loc)
  return loc
}

/**
 * All catalog hits for a raw contract name.
 * Gateways are excluded unless the query mentions gateway/jump.
 */
function locationFitsHaul(loc: Location, match?: HaulMatchContext): boolean {
  if (!match || match.scope === 'interstellar' || match.anchors.length === 0) return true
  return match.anchors.every((anchor) => locationsShareScope(anchor, loc, match.scope))
}

export function findAllLocationsByName(
  raw: string,
  match?: HaulMatchContext,
): Location[] {
  const q = normalize(raw)
  if (!q) return []
  const allowGateways = /gateway|jump|nyx\s+gate/i.test(raw)

  const exact: Location[] = []
  const fuzzy: { loc: Location; score: number }[] = []

  for (const loc of getAllLocations()) {
    if (loc.id.startsWith('custom-')) continue
    if (!allowGateways && isGateway(loc)) continue
    const names = [loc.name, loc.shortName, loc.id.replace(/-/g, ' '), ...(loc.aliases ?? [])]
    let locExact = false
    let bestFuzzy = 0
    for (const name of names) {
      const n = normalize(name)
      if (!n) continue
      // Ignore very short catalog tokens — they false-match too easily
      if (n.length < 3) continue
      if (q === n) {
        locExact = true
        break
      }
      // Require the query to be at least as specific as a short name fragment
      if (n.length < 5 && q !== n) continue
      if (q.includes(n) || n.includes(q)) {
        const score =
          Math.min(q.length, n.length) / Math.max(q.length, n.length) + n.length / 1000
        if (score > bestFuzzy) bestFuzzy = score
      }
    }
    if (locExact) exact.push(loc)
    else if (bestFuzzy >= 0.55) fuzzy.push({ loc, score: bestFuzzy })
  }

  const ranked = exact.length
    ? exact
    : fuzzy.sort((a, b) => b.score - a.score).map((f) => f.loc)
  if (!match) return ranked
  return ranked.filter((loc) => locationFitsHaul(loc, match))
}

export function findLocationByName(raw: string): Location | undefined {
  return findAllLocationsByName(raw)[0]
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const rows = b.length + 1
  let prev = Array.from({ length: rows }, (_, i) => i)
  let curr = new Array<number>(rows)
  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1
      curr[j + 1] = Math.min(prev[j + 1] + 1, curr[j] + 1, prev[j] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/**
 * Match OCR / contract place text to a catalog location.
 * Uses exact/includes first, then edit-distance for common OCR typos.
 */
export function matchOcrLocationName(
  raw: string,
  match?: HaulMatchContext,
): Location | undefined {
  const trimmed = raw
    .replace(/\s+at\s+the(?:\s+.*)?$/i, '')
    .replace(/\s+above\s+.*/i, '')
    .replace(/^to\s+/i, '')
    .trim()
  if (!trimmed) return undefined

  const unscoped = findAllLocationsByName(trimmed)
  const scoped = match
    ? unscoped.filter((loc) => locationFitsHaul(loc, match))
    : unscoped
  if (scoped[0]) return scoped[0]
  // A catalog name in the wrong system is not a typo for somewhere else.
  if (match && unscoped.length) return undefined

  const q = normalize(trimmed)
  if (q.length < 3) return undefined
  const allowGateways = /gateway|jump|nyx\s+gate/i.test(trimmed)
  const qCompact = q.replace(/\s+/g, '')

  let best: { loc: Location; score: number } | null = null
  for (const loc of getAllLocations()) {
    if (loc.id.startsWith('custom-')) continue
    if (!allowGateways && isGateway(loc)) continue
    if (!locationFitsHaul(loc, match)) continue
    const names = [loc.name, loc.shortName, loc.id.replace(/-/g, ' '), ...(loc.aliases ?? [])]
    for (const name of names) {
      const n = normalize(name)
      if (!n || n.length < 3) continue
      const nCompact = n.replace(/\s+/g, '')
      const dist = Math.min(editDistance(q, n), editDistance(qCompact, nCompact))
      const maxLen = Math.max(qCompact.length, nCompact.length, q.length, n.length)
      const similarity = 1 - dist / maxLen
      // Prefer similar length; reject wild mismatches
      if (similarity < 0.72) continue
      if (Math.abs(q.length - n.length) > Math.max(4, Math.floor(n.length * 0.4))) continue
      if (!best || similarity > best.score) best = { loc, score: similarity }
    }
  }
  return best && best.score >= 0.72 ? best.loc : undefined
}

/** Canonical short name for titles / labels, or the raw text if unknown. */
export function canonicalLocationLabel(raw: string): string {
  return matchOcrLocationName(raw)?.shortName ?? raw.trim()
}

/** Tracks stops already taken while parsing one contract. */
export interface LocationResolveCtx {
  usedIds: Set<string>
  /** Normalized OCR place-name strings already seen (for true duplicates). */
  usedRaws: Set<string>
  /**
   * When true, 2nd exact place-name → Nyx Gateway (Pyro).
   * Prefer handling collect-line duplicates in OCR; kept for resolve helpers.
   */
  nyxOnDuplicate: boolean
}

export function createLocationResolveCtx(
  opts: { nyxOnDuplicate?: boolean } = {},
): LocationResolveCtx {
  return {
    usedIds: new Set(),
    usedRaws: new Set(),
    nyxOnDuplicate: Boolean(opts.nyxOnDuplicate),
  }
}

function isExactNameMatch(raw: string, loc: Location): boolean {
  const q = normalize(raw)
  if (!q) return false
  const names = [loc.name, loc.shortName, loc.id.replace(/-/g, ' '), ...(loc.aliases ?? [])]
  return names.some((name) => normalize(name) === q)
}

/**
 * Resolve a location from a hauling contract.
 * Game quirk: the same place *name text* listed twice means the 2nd stop is
 * Nyx Gateway (Pyro). Fuzzy rematches to an already-used catalog ID do NOT count.
 */
export function resolveContractLocation(
  rawName: string,
  ctx: LocationResolveCtx = createLocationResolveCtx(),
  match?: HaulMatchContext,
): Location | undefined {
  const trimmed = rawName
    .replace(/\s+at\s+the(?:\s+.*)?$/i, '')
    .replace(/\s+above\s+.*/i, '')
    .trim()
  const rawKey = normalize(trimmed)

  const nyx = getNyxGatewayPyro()
  if (/nyx\s+gateway/i.test(trimmed)) {
    ctx.usedIds.add(nyx.id)
    if (rawKey) ctx.usedRaws.add(rawKey)
    return nyx
  }

  const unscoped = findAllLocationsByName(trimmed)
  const scoped = match
    ? unscoped.filter((loc) => locationFitsHaul(loc, match))
    : unscoped
  const primary = scoped[0] ?? matchOcrLocationName(trimmed, match)

  if (primary) {
    const exact = isExactNameMatch(trimmed, primary)
    const duplicateName = Boolean(rawKey && ctx.usedRaws.has(rawKey))
    // Only the in-game duplicate-name quirk — not “fuzzy hit same ID as dropoff”.
    // The quirk still points at Nyx even when that crosses the haul's system.
    const duplicateExactStop = exact && ctx.usedIds.has(primary.id)
    if (
      ctx.nyxOnDuplicate &&
      (duplicateName || duplicateExactStop) &&
      primary.id !== nyx.id &&
      !ctx.usedIds.has(nyx.id)
    ) {
      ctx.usedIds.add(nyx.id)
      if (rawKey) ctx.usedRaws.add(rawKey)
      return nyx
    }
    ctx.usedIds.add(primary.id)
    if (rawKey) ctx.usedRaws.add(rawKey)
    return primary
  }

  if (match && (unscoped.length > 0 || matchOcrLocationName(trimmed))) return undefined
  return ensureLocation(trimmed, ctx, scopeHint(match))
}

function scopeHint(
  match?: HaulMatchContext,
): { system?: string; body?: string } | undefined {
  const anchor = match?.anchors[0]
  if (!match || !anchor || match.scope === 'interstellar') return undefined
  if (match.scope === 'stellar') return { system: anchor.system }
  return { system: anchor.system, body: anchor.body }
}

/** Never drop an unknown stop — register a custom location near system average. */
export function ensureLocation(
  rawName: string,
  ctx?: LocationResolveCtx | Set<string>,
  hint?: { system?: string; body?: string },
): Location {
  const resolveCtx: LocationResolveCtx =
    ctx instanceof Set
      ? { usedIds: ctx, usedRaws: new Set(), nyxOnDuplicate: false }
      : (ctx ?? createLocationResolveCtx())
  const trimmed = rawName.replace(/\s+at\s+the(?:\s+.*)?$/i, '').replace(/\s+above\s+.*/i, '').trim()
  const rawKey = normalize(trimmed)
  const nyx = getNyxGatewayPyro()
  const existing = findLocationByName(trimmed)
  if (existing) {
    const exact = isExactNameMatch(trimmed, existing)
    const duplicateName = Boolean(rawKey && resolveCtx.usedRaws.has(rawKey))
    const duplicateExactStop = exact && resolveCtx.usedIds.has(existing.id)
    if (
      resolveCtx.nyxOnDuplicate &&
      (duplicateName || duplicateExactStop) &&
      existing.id !== nyx.id &&
      !resolveCtx.usedIds.has(nyx.id)
    ) {
      resolveCtx.usedIds.add(nyx.id)
      if (rawKey) resolveCtx.usedRaws.add(rawKey)
      return nyx
    }
    resolveCtx.usedIds.add(existing.id)
    if (rawKey) resolveCtx.usedRaws.add(rawKey)
    return existing
  }

  const id =
    'custom-' +
    trimmed
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)

  if (
    resolveCtx.nyxOnDuplicate &&
    rawKey &&
    resolveCtx.usedRaws.has(rawKey) &&
    !resolveCtx.usedIds.has(nyx.id)
  ) {
    resolveCtx.usedIds.add(nyx.id)
    return nyx
  }

  const known = customLocations.get(id)
  if (known) {
    if (hint?.system && (known.system !== hint.system || (hint.body && known.body !== hint.body))) {
      const placed: Location = {
        ...known,
        system: hint.system,
        body: hint.body ?? known.body,
      }
      customLocations.set(id, placed)
      resolveCtx.usedIds.add(placed.id)
      if (rawKey) resolveCtx.usedRaws.add(rawKey)
      return placed
    }
    if (
      resolveCtx.nyxOnDuplicate &&
      resolveCtx.usedIds.has(known.id) &&
      resolveCtx.usedRaws.has(rawKey) &&
      !resolveCtx.usedIds.has(nyx.id)
    ) {
      resolveCtx.usedIds.add(nyx.id)
      return nyx
    }
    resolveCtx.usedIds.add(known.id)
    if (rawKey) resolveCtx.usedRaws.add(rawKey)
    return known
  }

  const hinted = hint?.system
    ? state.locations.filter((l) => l.system === hint.system && !isGateway(l))
    : []
  const pyroStations = state.locations.filter(
    (l) => l.system === 'pyro' && !isGateway(l) && /station|service|nest|fuel|depot/i.test(l.name),
  )
  const pyroPool = pyroStations.length
    ? pyroStations
    : state.locations.filter((l) => l.system === 'pyro' && !isGateway(l))
  const pool = hinted.length ? hinted : pyroPool
  const usePool = pool.length ? pool : state.locations
  const avg = usePool.reduce(
    (a, l) => ({ x: a.x + l.x, y: a.y + l.y, z: a.z + l.z }),
    { x: 0, y: 0, z: 0 },
  )
  const n = Math.max(usePool.length, 1)
  const loc: Location = {
    id,
    name: trimmed || 'Unknown location',
    shortName: (trimmed || 'Unknown').slice(0, 28),
    body: hint?.body ?? 'Unknown',
    type: 'landing',
    system: hint?.system ?? (pool.length ? 'pyro' : 'unknown'),
    x: avg.x / n,
    y: avg.y / n,
    z: avg.z / n,
    aliases: [trimmed],
  }
  customLocations.set(id, loc)
  resolveCtx.usedIds.add(loc.id)
  if (rawKey) resolveCtx.usedRaws.add(rawKey)
  emit()
  return loc
}

export function locationsByBody(): Record<string, Location[]> {
  const map: Record<string, Location[]> = {}
  for (const loc of getAllLocations()) {
    const key =
      loc.system === 'pyro'
        ? `Pyro · ${loc.body}`
        : loc.system === 'stanton'
          ? loc.body
          : `${loc.system} · ${loc.body}`
    ;(map[key] ??= []).push(loc)
  }
  return map
}

export async function loadCatalog(
  opts: { refreshScmdb?: boolean } = {},
): Promise<void> {
  if (state.loading) return
  state = { ...state, loading: true, error: null }
  emit()
  try {
    const [ships, locations, commodities] = await Promise.all([
      fetchShips(),
      fetchLocations(),
      fetchCommodities(),
    ])
    // SCMDB demos + active givers: only when Refresh data is pressed (schedule is separate)
    if (opts.refreshScmdb) {
      const { refreshScmdbHaulCatalog } = await import('../lib/scmdbDemo')
      await refreshScmdbHaulCatalog().catch(() => {
        /* soft-fail — Demo keeps cache/bundle */
      })
    }
    const destNames = locations
      .filter((l) => /station|harbor|point|hex/i.test(l.name))
      .map((l) => l.shortName)
    state = {
      ships,
      locations,
      commodities,
      givers: listScmdbGivers(),
      missionNames: buildMissionNameOptions(destNames),
      loading: false,
      error: null,
      loadedAt: Date.now(),
    }
    emit()
  } catch (err) {
    state = {
      ...state,
      loading: false,
      error: err instanceof Error ? err.message : 'Failed to load catalog',
    }
    emit()
    throw err
  }
}

/** Re-read active hauling givers from the SCMDB catalog (after scheduled refresh). */
export function syncGiversFromScmdb(): void {
  state = { ...state, givers: listScmdbGivers() }
  emit()
}
