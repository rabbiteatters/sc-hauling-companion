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

/** Missions whose every stop on this route sits in a group marked done. */
export function completedMissionIds(
  groups: readonly { actions: readonly { missionId: string }[] }[],
  done: ReadonlySet<number>,
): Set<string> {
  const seen = new Set<string>()
  const open = new Set<string>()
  groups.forEach((group, index) => {
    const finished = done.has(index)
    for (const action of group.actions) {
      if (!action.missionId) continue
      seen.add(action.missionId)
      if (!finished) open.add(action.missionId)
    }
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
      ...(loadNote ? { loadNote } : {}),
    }
  })
  return { ...route, stops }
}
