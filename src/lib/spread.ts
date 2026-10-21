import { DEFAULT_HAUL_TYPE, inferHaulType } from './haulTypes'
import type { HaulType, Mission, MissionStop } from '../types'

/** Legal Star Citizen cargo crate sizes (powers of 2). */
export const CRATE_SIZES = [1, 2, 4, 8, 16, 32, 64] as const
export type CrateSize = (typeof CRATE_SIZES)[number]

export const DEFAULT_MAX_UNIT_SCU: CrateSize = 8

/** Snap any value down to the largest legal crate size ≤ n (default 8). */
export function normalizeCrateSize(n: number): CrateSize {
  const v = Math.round(Number(n) || 0)
  for (let i = CRATE_SIZES.length - 1; i >= 0; i--) {
    if (CRATE_SIZES[i] <= v) return CRATE_SIZES[i]
  }
  return 1
}

/**
 * Split total SCU across locations when the contract only shows a total.
 * Deals legal crates (≤ maxUnitScu) round-robin.
 */
export function spreadCargo(
  totalScu: number,
  locationCount: number,
  maxUnitScu: number = DEFAULT_MAX_UNIT_SCU,
): number[] {
  const n = Math.max(0, Math.floor(locationCount))
  if (n === 0) return []
  if (totalScu <= 0) return Array(n).fill(0)

  const crates = scuToBoxes(totalScu, maxUnitScu)
  const amounts = Array<number>(n).fill(0)
  crates.forEach((crate, i) => {
    amounts[i % n] += crate
  })
  return amounts
}

/**
 * Break an SCU pile into individual legal crates (1/2/4/8/16/32/64),
 * never exceeding maxUnitScu.
 */
export function scuToBoxes(scu: number, maxUnitScu: number = DEFAULT_MAX_UNIT_SCU): number[] {
  const cap = normalizeCrateSize(maxUnitScu)
  const allowed = CRATE_SIZES.filter((s) => s <= cap).slice().reverse()
  const boxes: number[] = []
  let left = Math.max(0, Math.round(scu))
  while (left > 0) {
    const size = allowed.find((s) => s <= left) ?? 1
    boxes.push(size)
    left -= size
  }
  return boxes
}

/** e.g. "3×8 + 1×4" */
export function formatBoxCounts(boxes: number[]): string {
  if (!boxes.length) return '0 boxes'
  const counts = new Map<number, number>()
  for (const b of boxes) counts.set(b, (counts.get(b) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([size, n]) => `${n}×${size}`)
    .join(' + ')
}

export function formatBoxList(boxes: number[]): string {
  if (!boxes.length) return '—'
  return boxes.map((b) => `${b}`).join(', ') + ' SCU'
}

/** Count crates by size, largest first. */
export function boxesToCounts(boxes: number[]): { size: number; count: number }[] {
  const counts = new Map<number, number>()
  for (const b of boxes) counts.set(b, (counts.get(b) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([size, count]) => ({ size, count }))
}

/** Expand size→count map back to total SCU. */
export function countsToScu(counts: Record<number, number>): number {
  let total = 0
  for (const [size, n] of Object.entries(counts)) {
    total += Number(size) * Math.max(0, Math.round(Number(n) || 0))
  }
  return total
}

/** Allowed crate sizes for a mission max-unit. */
export function allowedCrateSizes(maxUnitScu: number = DEFAULT_MAX_UNIT_SCU): CrateSize[] {
  const cap = normalizeCrateSize(maxUnitScu)
  return CRATE_SIZES.filter((s) => s <= cap).slice().reverse()
}

/**
 * Confirm actual SCU at a pickup; re-spread the remainder across
 * following unconfirmed pickups on the same mission.
 */
export function amendPickupActual(
  mission: Mission,
  locationId: string,
  actualScu: number,
): Mission {
  const idx = mission.pickups.findIndex((p) => p.locationId === locationId)
  if (idx < 0) return mission

  const pickups = mission.pickups.map((p) => ({ ...p }))
  const actual = Math.max(0, Math.round(actualScu))
  pickups[idx] = { ...pickups[idx], scu: actual, confirmed: true }

  const usedThrough = pickups.slice(0, idx + 1).reduce((s, p) => s + p.scu, 0)
  const laterConfirmedSum = pickups
    .filter((p, i) => i > idx && p.confirmed)
    .reduce((s, p) => s + p.scu, 0)
  const toSpread = Math.max(0, mission.totalScu - usedThrough - laterConfirmedSum)

  const followingIdx = pickups
    .map((_, i) => i)
    .filter((i) => i > idx && !pickups[i].confirmed)

  if (followingIdx.length === 0) {
    // No following stops — clamp is fine; leftover stays unmatched to total
  } else {
    const amounts = spreadCargo(toSpread, followingIdx.length, mission.maxUnitScu)
    followingIdx.forEach((fi, j) => {
      pickups[fi] = {
        ...pickups[fi],
        scu: amounts[j] ?? 0,
        confirmed: false,
      }
    })
  }

  const pickupSum = pickups.reduce((s, p) => s + p.scu, 0)
  const dropoffs =
    mission.dropoffs.length === 1
      ? [{ ...mission.dropoffs[0], scu: pickupSum }]
      : mission.dropoffs

  return { ...mission, pickups, dropoffs }
}

/** Re-spread only unconfirmed pickups (keeps confirmed actuals). */
export function respreadUnconfirmed(mission: Mission): Mission {
  const pickups = mission.pickups.map((p) => ({ ...p }))
  const confirmedSum = pickups.filter((p) => p.confirmed).reduce((s, p) => s + p.scu, 0)
  const openIdx = pickups.map((_, i) => i).filter((i) => !pickups[i].confirmed)
  const toSpread = Math.max(0, mission.totalScu - confirmedSum)

  if (openIdx.length) {
    const amounts = spreadCargo(toSpread, openIdx.length, mission.maxUnitScu)
    openIdx.forEach((i, j) => {
      pickups[i] = { ...pickups[i], scu: amounts[j] ?? 0 }
    })
  }

  const pickupSum = pickups.reduce((s, p) => s + p.scu, 0)
  const dropoffs =
    mission.dropoffs.length === 1
      ? [{ ...mission.dropoffs[0], scu: pickupSum }]
      : mission.dropoffs

  return { ...mission, pickups, dropoffs }
}

export function buildStops(
  locationIds: string[],
  totalScu: number,
  maxUnitScu: number = DEFAULT_MAX_UNIT_SCU,
): MissionStop[] {
  const unique = [...new Set(locationIds.filter(Boolean))]
  const amounts = spreadCargo(totalScu, unique.length, maxUnitScu)
  return unique.map((locationId, i) => ({
    locationId,
    scu: amounts[i] ?? 0,
    confirmed: false,
  }))
}

export function buildDropoffs(
  locationIds: string[],
  totalScu: number,
  maxUnitScu: number = DEFAULT_MAX_UNIT_SCU,
): MissionStop[] {
  const unique = [...new Set(locationIds.filter(Boolean))]
  if (unique.length === 0) return []
  if (unique.length === 1) return [{ locationId: unique[0], scu: totalScu }]
  return buildStops(unique, totalScu, maxUnitScu)
}

/** How cargo is spread across stops — derived from stop counts, not haul label. */
export type RouteShape = 'direct' | 'multiplePickUp' | 'multipleDropOff'

export function inferRouteShape(pickupCount: number, dropoffCount: number): RouteShape {
  if (pickupCount > 1 && dropoffCount <= 1) return 'multiplePickUp'
  if (dropoffCount > 1 && pickupCount <= 1) return 'multipleDropOff'
  return 'direct'
}

/** Format sequential mission codes: C01, C02, … */
export function formatMissionCode(n: number): string {
  return `C${String(Math.max(1, Math.round(n))).padStart(2, '0')}`
}

export function missionCodeNumber(code: string): number {
  const m = /^c(\d+)$/i.exec(code.trim())
  return m ? Number(m[1]) : 0
}

/** Next unused code given missions already in the list. */
export function nextMissionCode(existing: Mission[]): string {
  let max = 0
  for (const m of existing) {
    max = Math.max(max, missionCodeNumber(m.code))
  }
  return formatMissionCode(max + 1)
}

/** Assign C01…Cn to missions missing a code (keeps existing codes). */
export function ensureMissionCodes(missions: Mission[]): Mission[] {
  let max = 0
  for (const m of missions) {
    max = Math.max(max, missionCodeNumber(m.code))
  }
  return missions.map((m) => {
    if (m.code && missionCodeNumber(m.code) > 0) return m
    max += 1
    return { ...m, code: formatMissionCode(max) }
  })
}

export function createMission(input: {
  name: string
  pickupIds: string[]
  dropoffIds: string[]
  totalScu: number
  maxUnitScu?: number
  commodity?: string
  giver?: string
  rank?: string
  rewardAuec?: number
  source: Mission['source']
  haulType?: HaulType
  /** @deprecated use haulType */
  missionType?: HaulType
  id?: string
  code?: string
  /** Preserve confirmed pickups when rebuilding */
  priorPickups?: MissionStop[]
}): Mission {
  const maxUnitScu = normalizeCrateSize(input.maxUnitScu ?? DEFAULT_MAX_UNIT_SCU)
  const totalScu = Math.max(1, Math.round(input.totalScu))
  const haulType =
    input.haulType ??
    input.missionType ??
    inferHaulType(input.pickupIds.length, input.dropoffIds.length, input.name) ??
    DEFAULT_HAUL_TYPE
  const shape = inferRouteShape(input.pickupIds.length, input.dropoffIds.length)

  let pickups: MissionStop[]
  let dropoffs: MissionStop[]

  if (shape === 'multipleDropOff') {
    pickups = [{ locationId: input.pickupIds[0], scu: totalScu, confirmed: false }]
    dropoffs = buildDropoffs(input.dropoffIds, totalScu, maxUnitScu)
  } else if (shape === 'multiplePickUp') {
    pickups = buildStops(input.pickupIds, totalScu, maxUnitScu)
    dropoffs = [{ locationId: input.dropoffIds[0], scu: totalScu }]
  } else {
    pickups = [{ locationId: input.pickupIds[0], scu: totalScu, confirmed: false }]
    dropoffs = [{ locationId: input.dropoffIds[0], scu: totalScu }]
  }

  // Restore confirmed actuals from a prior version of the same stops
  if (input.priorPickups?.length) {
    const priorByLoc = new Map(
      input.priorPickups.filter((p) => p.confirmed).map((p) => [p.locationId, p]),
    )
    pickups = pickups.map((p) => {
      const prior = priorByLoc.get(p.locationId)
      return prior ? { ...p, scu: prior.scu, confirmed: true } : p
    })
    const mission: Mission = {
      id: input.id ?? crypto.randomUUID(),
      code: input.code ?? formatMissionCode(1),
      name: input.name,
      haulType,
      rank: input.rank?.trim() || undefined,
      giver: input.giver?.trim() || undefined,
      commodity: input.commodity,
      rewardAuec: input.rewardAuec,
      totalScu,
      maxUnitScu,
      pickups,
      dropoffs,
      source: input.source,
    }
    return respreadUnconfirmed(mission)
  }

  return {
    id: input.id ?? crypto.randomUUID(),
    code: input.code ?? formatMissionCode(1),
    name: input.name,
    haulType,
    rank: input.rank?.trim() || undefined,
    giver: input.giver?.trim() || undefined,
    commodity: input.commodity,
    rewardAuec: input.rewardAuec,
    totalScu,
    maxUnitScu,
    pickups,
    dropoffs,
    source: input.source,
  }
}

export function formatStopSummary(
  stops: MissionStop[],
  getName: (id: string) => string,
  maxUnitScu?: number,
): string {
  return stops
    .map((s) => {
      const boxes =
        maxUnitScu != null ? ` [${formatBoxCounts(scuToBoxes(s.scu, maxUnitScu))}]` : ''
      const mark = s.confirmed ? '✓' : ''
      return `${getName(s.locationId)} (${s.scu}${boxes})${mark}`
    })
    .join(' · ')
}
