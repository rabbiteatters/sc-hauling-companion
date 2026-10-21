import { locationLabel } from '../store/catalog'
import type { Mission, MissionObjective, MissionStop } from '../types'
import { buildDropoffs, buildStops, DEFAULT_MAX_UNIT_SCU } from './spread'

export function newObjectiveId(): string {
  return crypto.randomUUID()
}

export function createEmptyObjective(
  partial?: Partial<MissionObjective>,
): MissionObjective {
  return {
    id: partial?.id ?? newObjectiveId(),
    commodity: partial?.commodity ?? '',
    totalScu: Math.max(0, Math.round(partial?.totalScu ?? 0)),
    pickups: partial?.pickups?.map(cloneStop) ?? [],
    dropoffs: partial?.dropoffs?.map(cloneStop) ?? [],
  }
}

function cloneStop(s: MissionStop): MissionStop {
  return {
    locationId: s.locationId,
    scu: Math.max(0, Math.round(s.scu) || 0),
    confirmed: Boolean(s.confirmed),
  }
}

export function sanitizeObjective(raw: unknown): MissionObjective | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<MissionObjective>
  const pickups = Array.isArray(o.pickups)
    ? o.pickups
        .filter((p) => p && typeof p.locationId === 'string')
        .map((p) => ({
          locationId: p.locationId,
          scu: Math.max(0, Number(p.scu) || 0),
          confirmed: Boolean(p.confirmed),
        }))
    : []
  const dropoffs = Array.isArray(o.dropoffs)
    ? o.dropoffs
        .filter((d) => d && typeof d.locationId === 'string')
        .map((d) => ({
          locationId: d.locationId,
          scu: Math.max(0, Number(d.scu) || 0),
        }))
    : []
  return {
    id: typeof o.id === 'string' && o.id ? o.id : newObjectiveId(),
    commodity: typeof o.commodity === 'string' ? o.commodity : '',
    totalScu: Math.max(0, Number(o.totalScu) || 0),
    pickups,
    dropoffs,
  }
}

/** Wrap legacy flat cargo into a single objective. */
export function legacyMissionToObjectives(
  m: Pick<Mission, 'commodity' | 'totalScu' | 'pickups' | 'dropoffs'> & {
    objectives?: MissionObjective[]
  },
): MissionObjective[] {
  if (Array.isArray(m.objectives) && m.objectives.length) {
    return m.objectives.map((o) => sanitizeObjective(o)).filter((o): o is MissionObjective => o != null)
  }
  return [
    createEmptyObjective({
      commodity: m.commodity ?? '',
      totalScu: Math.max(0, Number(m.totalScu) || 0),
      pickups: m.pickups ?? [],
      dropoffs: m.dropoffs ?? [],
    }),
  ]
}

export function missionTotalScu(objectives: MissionObjective[]): number {
  return objectives.reduce((s, o) => s + Math.max(0, o.totalScu), 0)
}

export function missionCommodityLabel(objectives: MissionObjective[]): string {
  const names = [
    ...new Set(objectives.map((o) => o.commodity.trim()).filter(Boolean)),
  ]
  if (!names.length) return ''
  if (names.length === 1) return names[0]
  return `${names.length} commodities`
}

/** Flatten pickups across objectives (first occurrence wins for confirmed). */
export function flattenPickups(objectives: MissionObjective[]): MissionStop[] {
  const out: MissionStop[] = []
  const seen = new Set<string>()
  for (const o of objectives) {
    for (const p of o.pickups) {
      if (seen.has(p.locationId)) continue
      seen.add(p.locationId)
      out.push(cloneStop(p))
    }
  }
  return out
}

export function flattenDropoffs(objectives: MissionObjective[]): MissionStop[] {
  const out: MissionStop[] = []
  const seen = new Set<string>()
  for (const o of objectives) {
    for (const d of o.dropoffs) {
      if (seen.has(d.locationId)) continue
      seen.add(d.locationId)
      out.push({ locationId: d.locationId, scu: d.scu })
    }
  }
  return out
}

/** Set mission aggregates from objectives (mutates copy). */
export function withObjectiveAggregates<T extends {
  objectives: MissionObjective[]
  commodity?: string
  totalScu: number
  pickups: MissionStop[]
  dropoffs: MissionStop[]
}>(mission: T): T {
  const objectives = mission.objectives.length
    ? mission.objectives
    : legacyMissionToObjectives(mission)
  return {
    ...mission,
    objectives,
    totalScu: Math.max(1, missionTotalScu(objectives) || 1),
    commodity: missionCommodityLabel(objectives) || undefined,
    pickups: flattenPickups(objectives),
    dropoffs: flattenDropoffs(objectives),
  }
}

export function objectiveRouteParts(objectives: MissionObjective[]): {
  from: string
  to: string
  pickupCount: number
  dropoffCount: number
} {
  const pickupIds = [
    ...new Set(objectives.flatMap((o) => o.pickups.map((p) => p.locationId))),
  ]
  const dropoffIds = [
    ...new Set(objectives.flatMap((o) => o.dropoffs.map((d) => d.locationId))),
  ]
  return {
    from: pickupIds[0] ? locationLabel(pickupIds[0]) : '',
    to: dropoffIds.length
      ? locationLabel(dropoffIds[dropoffIds.length - 1])
      : '',
    pickupCount: pickupIds.length,
    dropoffCount: dropoffIds.length,
  }
}

export function objectiveSummaryLine(obj: MissionObjective): string {
  const from = obj.pickups[0] ? locationLabel(obj.pickups[0].locationId) : '—'
  const to = obj.dropoffs.length
    ? locationLabel(obj.dropoffs[obj.dropoffs.length - 1].locationId)
    : '—'
  const fromPart = obj.pickups.length > 1 ? 'MULTI' : from
  const toPart = obj.dropoffs.length > 1 ? 'MULTI' : to
  const pickSum = obj.pickups.reduce((s, p) => s + p.scu, 0)
  const dropSum = obj.dropoffs.reduce((s, d) => s + d.scu, 0)
  return `${obj.commodity.trim() || 'Commodity'} · ${obj.totalScu} SCU · ${fromPart} → ${toPart} · ${obj.pickups.length}↑ ${obj.dropoffs.length}↓ · ${pickSum}/${dropSum}`
}

/** Spread total across current pickup/dropoff location lists. */
export function spreadObjectiveTotal(
  obj: MissionObjective,
  maxUnitScu: number = DEFAULT_MAX_UNIT_SCU,
): MissionObjective {
  const total = Math.max(0, Math.round(obj.totalScu))
  const pickupIds = obj.pickups.map((p) => p.locationId)
  const dropoffIds = obj.dropoffs.map((d) => d.locationId)
  return {
    ...obj,
    totalScu: total,
    pickups: pickupIds.length
      ? buildStops(pickupIds, total, maxUnitScu)
      : [],
    dropoffs: dropoffIds.length
      ? buildDropoffs(dropoffIds, total, maxUnitScu)
      : [],
  }
}

/** Respread one side from Total; leaves the other side unchanged. */
export function spreadObjectiveSide(
  obj: MissionObjective,
  side: 'pickup' | 'dropoff',
  maxUnitScu: number = DEFAULT_MAX_UNIT_SCU,
): MissionObjective {
  const total = Math.max(0, Math.round(obj.totalScu))
  if (side === 'pickup') {
    const pickupIds = obj.pickups.map((p) => p.locationId)
    return {
      ...obj,
      pickups: pickupIds.length
        ? buildStops(pickupIds, total, maxUnitScu)
        : [],
    }
  }
  const dropoffIds = obj.dropoffs.map((d) => d.locationId)
  return {
    ...obj,
    dropoffs: dropoffIds.length
      ? buildDropoffs(dropoffIds, total, maxUnitScu)
      : [],
  }
}

/**
 * When a side has exactly one location, keep that stop's SCU equal to Total.
 * Multi-location sides are left unchanged.
 */
function syncSingletonStops(
  obj: MissionObjective,
  totalScu: number,
): MissionObjective {
  const total = Math.max(0, Math.round(totalScu) || 0)
  let pickups = obj.pickups
  let dropoffs = obj.dropoffs
  if (pickups.length === 1 && pickups[0].scu !== total) {
    pickups = [{ ...pickups[0], scu: total }]
  }
  if (dropoffs.length === 1 && dropoffs[0].scu !== total) {
    dropoffs = [{ ...dropoffs[0], scu: total }]
  }
  return { ...obj, totalScu: total, pickups, dropoffs }
}

/** User changed Total SCU — singleton pickup/dropoff locations follow Total. */
export function setObjectiveTotal(
  obj: MissionObjective,
  totalScu: number,
  _maxUnitScu: number = DEFAULT_MAX_UNIT_SCU,
): MissionObjective {
  return syncSingletonStops(obj, totalScu)
}

export type ObjectiveLoadBalance = {
  pickSum: number
  dropSum: number
  total: number
  /** Delta to set total = pickup sum (null if no pickups or already matches) */
  pickDelta: number | null
  /** Delta to set total = dropoff sum */
  dropDelta: number | null
  /** This side’s loads don’t match Total (false when 1 location already equals Total) */
  pickMismatch: boolean
  dropMismatch: boolean
  /** Any side/total inconsistency worth flagging */
  mismatch: boolean
  message: string | null
}

export function objectiveLoadBalance(obj: MissionObjective): ObjectiveLoadBalance {
  const pickSum = obj.pickups.reduce((s, p) => s + p.scu, 0)
  const dropSum = obj.dropoffs.reduce((s, d) => s + d.scu, 0)
  const total = Math.max(0, Math.round(obj.totalScu) || 0)

  const pickDelta =
    obj.pickups.length > 0 && pickSum !== total ? pickSum - total : null
  const dropDelta =
    obj.dropoffs.length > 0 && dropSum !== total ? dropSum - total : null

  // Side matches Total → not red (includes 1 location equal to Total)
  const pickMismatch = obj.pickups.length > 0 && pickSum !== total
  const dropMismatch = obj.dropoffs.length > 0 && dropSum !== total

  // Only warn pick↔drop when both sides exist and disagree; skip if each
  // singleton already equals Total (they then agree with each other too)
  const pickDropMismatch =
    obj.pickups.length > 0 &&
    obj.dropoffs.length > 0 &&
    pickSum !== dropSum

  const mismatch = pickMismatch || dropMismatch || pickDropMismatch
  let message: string | null = null
  if (pickMismatch && dropMismatch) {
    message = `Total ${total} ≠ pick ${pickSum} / drop ${dropSum}`
  } else if (pickDropMismatch && !pickMismatch && !dropMismatch) {
    message = `Pickups (${pickSum}) and dropoffs (${dropSum}) don't match`
  } else if (pickMismatch) {
    message = `Pickups (${pickSum}) don't match total (${total})`
  } else if (dropMismatch) {
    message = `Dropoffs (${dropSum}) don't match total (${total})`
  } else if (pickDropMismatch) {
    message = `Pickups (${pickSum}) and dropoffs (${dropSum}) don't match`
  }

  return {
    pickSum,
    dropSum,
    total,
    pickDelta,
    dropDelta,
    pickMismatch,
    dropMismatch,
    mismatch,
    message,
  }
}

/** Edit one location's SCU — does not change Total or the other side. */
export function setObjectiveStopScu(
  obj: MissionObjective,
  side: 'pickup' | 'dropoff',
  locationId: string,
  scu: number,
  _maxUnitScu: number = DEFAULT_MAX_UNIT_SCU,
): MissionObjective {
  const amount = Math.max(0, Math.round(scu) || 0)
  const stops = (side === 'pickup' ? obj.pickups : obj.dropoffs).map((s) =>
    s.locationId === locationId ? { ...s, scu: amount } : s,
  )
  return {
    ...obj,
    ...(side === 'pickup' ? { pickups: stops } : { dropoffs: stops }),
  }
}

/**
 * Change pickup/dropoff location ids.
 * Keeps existing loads; new locations start at 0.
 * If a side ends up with exactly one location and Total is set, that stop follows Total.
 */
export function changeObjectiveLocationIds(
  obj: MissionObjective,
  side: 'pickup' | 'dropoff',
  nextIds: string[],
  _maxUnitScu: number = DEFAULT_MAX_UNIT_SCU,
): MissionObjective {
  const unique = [...new Set(nextIds.filter(Boolean))]
  const prev = side === 'pickup' ? obj.pickups : obj.dropoffs
  const prevById = new Map(prev.map((s) => [s.locationId, s]))

  const stops: MissionStop[] = unique.map((id) => {
    const old = prevById.get(id)
    if (old) return { ...old }
    return { locationId: id, scu: 0, confirmed: false }
  })

  const next: MissionObjective = {
    ...obj,
    ...(side === 'pickup' ? { pickups: stops } : { dropoffs: stops }),
  }
  if (obj.totalScu > 0 && stops.length === 1) {
    return syncSingletonStops(next, obj.totalScu)
  }
  return next
}

/** Apply +/- chip: adjusts Total; singleton locations follow. */
export function applyObjectiveTotalDelta(
  obj: MissionObjective,
  delta: number,
  _maxUnitScu: number = DEFAULT_MAX_UNIT_SCU,
): MissionObjective {
  return syncSingletonStops(obj, obj.totalScu + delta)
}

export function moveObjective(
  list: MissionObjective[],
  index: number,
  dir: -1 | 1,
): MissionObjective[] {
  const j = index + dir
  if (j < 0 || j >= list.length) return list
  const next = [...list]
  const tmp = next[index]
  next[index] = next[j]
  next[j] = tmp
  return next
}

/** Draft-friendly objective without confirmed flags required. */
export type DraftObjective = {
  id: string
  commodity: string
  totalScu: number
  pickups: MissionStop[]
  dropoffs: MissionStop[]
}

export function draftObjectiveToMission(o: DraftObjective): MissionObjective {
  return createEmptyObjective(o)
}

export function objectivesFromFlat(input: {
  commodity?: string
  totalScu: number
  pickupIds: string[]
  dropoffIds: string[]
  maxUnitScu?: number
  pickups?: MissionStop[]
  dropoffs?: MissionStop[]
}): MissionObjective[] {
  const maxUnit = input.maxUnitScu ?? DEFAULT_MAX_UNIT_SCU
  const total = Math.max(0, Math.round(input.totalScu) || 0)
  if (input.pickups?.length || input.dropoffs?.length) {
    return [
      createEmptyObjective({
        commodity: input.commodity ?? '',
        totalScu: total,
        pickups: input.pickups ?? [],
        dropoffs: input.dropoffs ?? [],
      }),
    ]
  }
  const pickupIds = input.pickupIds.filter(Boolean)
  const dropoffIds = input.dropoffIds.filter(Boolean)
  return [
    createEmptyObjective({
      commodity: input.commodity ?? '',
      totalScu: total,
      pickups: pickupIds.length ? buildStops(pickupIds, total || 0, maxUnit) : [],
      dropoffs: dropoffIds.length
        ? buildDropoffs(dropoffIds, total || 0, maxUnit)
        : [],
    }),
  ]
}
