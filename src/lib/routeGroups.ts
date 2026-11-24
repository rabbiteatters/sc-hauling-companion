import { stopIsAutoBalance } from './objectives'
import type { Mission, MissionObjective, OptimizedRoute, RouteLocationGroup, RouteStop } from '../types'
import { sanitizeBoxes, scuToBoxes } from './spread'

/** Collapse consecutive actions at the same location into one visit card. */
export function groupRouteByLocation(stops: RouteStop[]): RouteLocationGroup[] {
  const groups: RouteLocationGroup[] = []

  for (const stop of stops) {
    const last = groups[groups.length - 1]
    if (last && last.locationId === stop.locationId && last.trip === stop.trip) {
      last.actions.push(stop)
      if (stop.kind === 'pickup') last.totalLoad += Math.abs(stop.cargoDelta)
      else last.totalDrop += Math.abs(stop.cargoDelta)
    } else {
      groups.push({
        locationId: stop.locationId,
        locationName: stop.locationName,
        trip: stop.trip,
        legDistance: stop.legDistance,
        actions: [stop],
        totalLoad: stop.kind === 'pickup' ? Math.abs(stop.cargoDelta) : 0,
        totalDrop: stop.kind === 'dropoff' ? Math.abs(stop.cargoDelta) : 0,
      })
    }
  }

  return groups
}

export function leadingDoneCount(done: ReadonlySet<number>): number {
  let n = 0
  while (done.has(n)) n++
  return n
}

const MARK_SEP = '\u001f'

/** One load or unload inside a location visit. Index-based so labels can change. */
export function actionMarkKey(groupIndex: number, actionIndex: number): string {
  return `${groupIndex}${MARK_SEP}${actionIndex}`
}

export function actionKeysForGroups(
  groups: readonly { actions: readonly unknown[] }[],
  indexes: Iterable<number>,
): Set<string> {
  const keys = new Set<string>()
  for (const index of indexes) {
    const group = groups[index]
    if (!group) continue
    group.actions.forEach((_, actionIndex) => keys.add(actionMarkKey(index, actionIndex)))
  }
  return keys
}

/** Visits where every load and unload has been marked. */
export function fullyDoneGroupIndexes(
  groups: readonly { actions: readonly unknown[] }[],
  marks: ReadonlySet<string>,
): Set<number> {
  const done = new Set<number>()
  groups.forEach((group, index) => {
    if (
      group.actions.length > 0 &&
      group.actions.every((_, actionIndex) => marks.has(actionMarkKey(index, actionIndex)))
    ) {
      done.add(index)
    }
  })
  return done
}

export function remapActionMarks(
  marks: ReadonlySet<string>,
  mapIndex: (index: number) => number | null,
): Set<string> {
  const next = new Set<string>()
  for (const key of marks) {
    const sep = key.indexOf(MARK_SEP)
    const index = Number(key.slice(0, sep))
    if (!Number.isInteger(index)) continue
    const mapped = mapIndex(index)
    if (mapped == null) continue
    next.add(`${mapped}${key.slice(sep)}`)
  }
  return next
}

/** Missions whose every load and unload on this route is marked. */
export function completedMissionIds(
  groups: readonly { actions: readonly { missionId: string }[] }[],
  marks: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>()
  const open = new Set<string>()
  groups.forEach((group, index) => {
    group.actions.forEach((action, actionIndex) => {
      if (!action.missionId) return
      seen.add(action.missionId)
      if (!marks.has(actionMarkKey(index, actionIndex))) open.add(action.missionId)
    })
  })
  const completed = new Set<string>()
  for (const id of seen) {
    if (!open.has(id)) completed.add(id)
  }
  return completed
}

/**
 * Stops that Calculate rest keeps: the leading done run, plus any done stop
 * after the current step.
 */
export function followingDoneIndices(
  done: ReadonlySet<number>,
  groupCount: number,
  currentStep: number,
): number[] {
  const chosen = new Set<number>()
  const lead = leadingDoneCount(done)
  for (let i = 0; i < lead && i < groupCount; i++) chosen.add(i)
  for (const i of done) {
    if (i > currentStep && i >= 0 && i < groupCount) chosen.add(i)
  }
  return [...chosen].sort((a, b) => a - b)
}

function loadNoteFor(mission: Mission | undefined, commodity?: string): string {
  if (!mission?.objectives?.length) return ''
  const wanted = commodity?.trim()
  const match = wanted
    ? mission.objectives.find((o) => o.commodity.trim() === wanted)
    : mission.objectives[0]
  return match?.loadNote?.trim() ?? ''
}

function objectivesForStop(mission: Mission | undefined, commodity?: string): MissionObjective[] {
  const objectives = mission?.objectives ?? []
  const wanted = commodity?.trim()
  if (!wanted) return objectives
  const matched = objectives.filter((o) => o.commodity.trim() === wanted)
  return matched.length ? matched : objectives
}

/** User-set crates when they still add up to this action; otherwise the largest legal packing. */
function boxesForStop(mission: Mission | undefined, stop: RouteStop): number[] {
  const maxUnit = mission?.maxUnitScu ?? 8
  const scu = Math.abs(stop.cargoDelta)
  const objectives = objectivesForStop(mission, stop.commodity)
  if (stop.kind === 'pickup') {
    for (const objective of objectives) {
      const pickup = objective.pickups.find((p) => p.locationId === stop.locationId)
      const boxes = sanitizeBoxes(pickup?.boxes, scu, maxUnit)
      if (boxes) return boxes
    }
    return scuToBoxes(scu, maxUnit)
  }

  const stored: number[] = []
  let covered = 0
  for (const objective of objectives) {
    for (const pickup of objective.pickups) {
      const boxes =
        sanitizeBoxes(pickup.boxes, pickup.scu, maxUnit) ?? scuToBoxes(pickup.scu, maxUnit)
      stored.push(...boxes)
      covered += pickup.scu
    }
  }
  if (covered === scu && stored.length) return stored
  return scuToBoxes(scu, maxUnit)
}

/** True when this action's SCU is an unconfirmed split across more than one stop. */
function balancedAmount(mission: Mission | undefined, stop: RouteStop): boolean {
  const objectives = objectivesForStop(mission, stop.commodity)
  const side = stop.kind === 'pickup' ? 'pickup' : 'dropoff'
  for (const objective of objectives) {
    const stops = side === 'pickup' ? objective.pickups : objective.dropoffs
    if (!stops.some((s) => s.locationId === stop.locationId)) continue
    return stopIsAutoBalance(objective, side, stop.locationId)
  }
  return false
}

/** Attach box breakdowns + clearer mission labels from catalog. */
export function enrichStopsWithBoxes(
  route: OptimizedRoute,
  missions: Mission[],
): OptimizedRoute {
  const byId = new Map(missions.map((m) => [m.id, m]))
  const stops = route.stops.map((s) => {
    const m = byId.get(s.missionId)
    const objectives = objectivesForStop(m, s.commodity)
    const pickup = objectives
      .flatMap((o) => o.pickups)
      .find((p) => p.locationId === s.locationId)
    const labelParts = [
      m?.code,
      m?.commodity,
      m ? `${m.totalScu} SCU` : null,
      s.missionName,
    ].filter(Boolean)
    const loadNote = loadNoteFor(m, s.commodity)
    return {
      ...s,
      missionName: labelParts.join(' · ') || s.missionName,
      boxes: boxesForStop(m, s),
      commodity: s.commodity || m?.commodity,
      confirmed: s.kind === 'pickup' ? Boolean(pickup?.confirmed) : undefined,
      balanced: balancedAmount(m, s),
      ...(loadNote ? { loadNote } : {}),
    }
  })
  return { ...route, stops }
}
