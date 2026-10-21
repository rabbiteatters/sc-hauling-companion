import type { Mission, OptimizedRoute, RouteLocationGroup, RouteStop } from '../types'
import { scuToBoxes } from './spread'

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

/** Attach box breakdowns + clearer mission labels from catalog. */
export function enrichStopsWithBoxes(
  route: OptimizedRoute,
  missions: Mission[],
): OptimizedRoute {
  const byId = new Map(missions.map((m) => [m.id, m]))
  const stops = route.stops.map((s) => {
    const m = byId.get(s.missionId)
    const maxUnit = m?.maxUnitScu ?? 8
    const pickup = m?.pickups.find((p) => p.locationId === s.locationId)
    const labelParts = [
      m?.code,
      m?.commodity,
      m ? `${m.totalScu} SCU` : null,
      s.missionName,
    ].filter(Boolean)
    return {
      ...s,
      missionName: labelParts.join(' · ') || s.missionName,
      boxes: scuToBoxes(Math.abs(s.cargoDelta), maxUnit),
      commodity: m?.commodity,
      confirmed: s.kind === 'pickup' ? Boolean(pickup?.confirmed) : undefined,
    }
  })
  return { ...route, stops }
}
