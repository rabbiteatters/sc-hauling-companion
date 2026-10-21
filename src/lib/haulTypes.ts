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

/** In-game hauling contract ranks (high → low). */
export const HAUL_RANKS: HaulRank[] = [
  'Master',
  'Expert',
  'Senior',
  'Experienced',
  'Junior',
  'Rookie',
  'Trainee',
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

/**
 * Auto title: Giver | Rank | Haul Type | route
 * - 1 pickup + 1 dropoff → From A To B
 * - multi pickup + 1 dropoff → From MULTI To B
 * - 1 pickup + multi dropoff → From A To MULTI
 * - multi both → From MULTI To MULTI
 */
export function buildAutoMissionName(parts: {
  giver?: string
  rank?: string
  haulType?: string
  from?: string
  to?: string
  pickupCount?: number
  dropoffCount?: number
  /** Prefix title with (DEMO) for sample hauls */
  demo?: boolean
}): string {
  const fromLabel = parts.from?.trim() || ''
  const toLabel = parts.to?.trim() || ''
  const pickups = parts.pickupCount ?? (fromLabel ? 1 : 0)
  const dropoffs = parts.dropoffCount ?? (toLabel ? 1 : 0)

  let route = ''
  if (pickups >= 1 && dropoffs >= 1) {
    const fromPart = pickups === 1 ? fromLabel : 'MULTI'
    const toPart = dropoffs === 1 ? toLabel : 'MULTI'
    route = `From ${fromPart} To ${toPart}`
  } else if (pickups === 1 && fromLabel) {
    route = `From ${fromLabel}`
  } else if (dropoffs === 1 && toLabel) {
    route = `To ${toLabel}`
  } else if (pickups > 1) {
    route = 'From MULTI'
  } else if (dropoffs > 1) {
    route = 'To MULTI'
  }

  const core = [parts.giver, parts.rank, parts.haulType, route]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(' | ')
  if (!core) return parts.demo ? '(DEMO)' : ''
  return parts.demo ? `(DEMO) ${core}` : core
}

/** Max stops per side (pickups or dropoffs). Both sides may be multi. */
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
 * Cap each side at max. Multi pickups and multi dropoffs may both be set.
 * `changed` is kept for call-site compatibility.
 */
export function reconcileHaulStops(
  pickupIds: string[],
  dropoffIds: string[],
  _changed: 'pickup' | 'dropoff',
  max = MAX_HAUL_STOPS,
): { pickupIds: string[]; dropoffIds: string[] } {
  return {
    pickupIds: pickupIds.filter(Boolean).slice(0, max),
    dropoffIds: dropoffIds.filter(Boolean).slice(0, max),
  }
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
