import type { HaulRank, HaulType } from '../types'

export const HAUL_TYPES: HaulType[] = [
  'Local Small Haul',
  'Local Medium Haul',
  'Planetary Small Haul',
  'Planetary Medium Haul',
  'Planetary Large Haul',
  'Stellar Small Haul',
  'Stellar Medium Haul',
  'Stellar Large Haul',
  'Interstellar Small Haul',
  'Interstellar Medium Haul',
  'Interstellar Large Haul',
]

/** In-game hauling contract ranks (separate from haul type in the title). */
export const HAUL_RANKS: HaulRank[] = [
  'Trainee',
  'Rookie',
  'Junior',
  'Experienced',
  'Senior',
  'Expert',
  'Master',
]

export const DEFAULT_HAUL_TYPE: HaulType = 'Stellar Medium Haul'
export const DEFAULT_HAUL_RANK: HaulRank = 'Experienced'

export function parseHaulRank(text: string): HaulRank | undefined {
  const lower = text.toLowerCase()
  for (const r of HAUL_RANKS) {
    if (new RegExp(`\\b${r.toLowerCase()}\\b`).test(lower)) return r
  }
  return undefined
}

/** Auto title: Giver | Rank | Haul Type | From Start / To End */
export function buildAutoMissionName(parts: {
  giver?: string
  rank?: string
  haulType?: string
  from?: string
  to?: string
}): string {
  const route =
    parts.from && parts.to
      ? `From ${parts.from} / To ${parts.to}`
      : parts.from
        ? `From ${parts.from}`
        : parts.to
          ? `To ${parts.to}`
          : ''
  return [parts.giver, parts.rank, parts.haulType, route]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(' | ')
}

/** Max stops on the multi side of a haul (pickups or dropoffs). */
export const MAX_HAUL_STOPS = 5

/** Multi-pickup contracts (typical stellar / interstellar). */
export function haulAllowsMultiPickup(haul: HaulType): boolean {
  return /^(Stellar|Interstellar|Planetary)/i.test(haul)
}

/** Multi-dropoff contracts (some planetary / local variants). */
export function haulAllowsMultiDropoff(haul: HaulType): boolean {
  return /^(Planetary|Local)/i.test(haul)
}

/**
 * Multi is allowed on pickups or dropoffs (not both). Cap each side at max.
 * When one side goes multi, the other collapses to a single stop.
 */
export function reconcileHaulStops(
  pickupIds: string[],
  dropoffIds: string[],
  changed: 'pickup' | 'dropoff',
  max = MAX_HAUL_STOPS,
): { pickupIds: string[]; dropoffIds: string[] } {
  let picks = pickupIds.filter(Boolean).slice(0, max)
  let drops = dropoffIds.filter(Boolean).slice(0, max)
  if (changed === 'pickup' && picks.length > 1 && drops.length > 1) {
    drops = drops.slice(0, 1)
  }
  if (changed === 'dropoff' && drops.length > 1 && picks.length > 1) {
    picks = picks.slice(0, 1)
  }
  return { pickupIds: picks, dropoffIds: drops }
}

export function parseHaulType(text: string): HaulType | undefined {
  const lower = text.toLowerCase()
  for (const h of HAUL_TYPES) {
    if (lower.includes(h.toLowerCase())) return h
  }
  // Loose scope + size
  const scope = lower.match(/\b(local|planetary|stellar|interstellar)\b/)?.[1]
  const size = lower.match(/\b(small|medium|large)\b/)?.[1]
  if (scope) {
    const s = (size ?? 'medium').replace(/^./, (c) => c.toUpperCase())
    const scopeLabel = scope.replace(/^./, (c) => c.toUpperCase())
    const candidate = `${scopeLabel} ${s} Haul` as HaulType
    if ((HAUL_TYPES as string[]).includes(candidate)) return candidate
    const medium = `${scopeLabel} Medium Haul` as HaulType
    if ((HAUL_TYPES as string[]).includes(medium)) return medium
  }
  return undefined
}

export function inferHaulType(
  pickupCount: number,
  dropoffCount: number,
  name?: string,
): HaulType {
  const fromName = name ? parseHaulType(name) : undefined
  if (fromName) return fromName
  if (pickupCount > 1) return 'Stellar Medium Haul'
  if (dropoffCount > 1) return 'Planetary Medium Haul'
  return 'Local Medium Haul'
}
