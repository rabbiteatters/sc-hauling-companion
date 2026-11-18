import type { Location } from '../types'
import { isMoon, locationBodies, normalizeBody, planetGroup } from './bodies'

/** How far apart a haul's stops are allowed to be. */
export type HaulScope = 'local' | 'planetary' | 'stellar' | 'interstellar'

const SYSTEM_TAGS = new Set(['Stanton', 'Pyro'])

export function haulScopeOf(haul: string | undefined): HaulScope {
  const scope = (haul ?? '').trim().toLowerCase()
  if (scope.startsWith('interstellar')) return 'interstellar'
  if (scope.startsWith('stellar')) return 'stellar'
  if (scope.startsWith('planetary')) return 'planetary'
  return 'local'
}

export function locationsShareScope(
  a: Location,
  b: Location,
  scope: HaulScope,
): boolean {
  if (a.id === b.id) return true
  if (scope === 'interstellar') return true
  if (scope === 'stellar') return sameSystem(a, b)
  if (scope === 'planetary') return samePlanet(a, b)
  return sameBody(a, b)
}

/** Locations the picker may offer once a contract already has stops. */
export function locationsAllowedForHaul(
  all: Location[],
  haul: string | undefined,
  anchors: Location[],
): Location[] {
  const scope = haulScopeOf(haul)
  if (scope === 'interstellar' || anchors.length === 0) return all
  const anchor = anchors[0]
  const allowed = all.filter((loc) => locationsShareScope(anchor, loc, scope))
  const seen = new Set(allowed.map((loc) => loc.id))
  for (const loc of anchors) {
    if (!seen.has(loc.id)) {
      allowed.push(loc)
      seen.add(loc.id)
    }
  }
  return allowed
}

/**
 * Keep the first stop, then only later stops that still fit the haul.
 * Returns the stops that remain and the anchors they established.
 */
export function retainStopsForHaul<T extends { locationId: string }>(
  stops: T[],
  lookup: (id: string) => Location | undefined,
  scope: HaulScope,
  anchors: Location[],
): { kept: T[]; anchors: Location[] } {
  const next = [...anchors]
  const kept: T[] = []
  for (const stop of stops) {
    const loc = lookup(stop.locationId)
    if (!loc) {
      kept.push(stop)
      continue
    }
    if (scope !== 'interstellar' && next.length && !next.every((a) => locationsShareScope(a, loc, scope))) {
      continue
    }
    next.push(loc)
    kept.push(stop)
  }
  return { kept, anchors: next }
}

function sameSystem(a: Location, b: Location): boolean {
  const sysA = (a.system ?? '').toLowerCase()
  const sysB = (b.system ?? '').toLowerCase()
  if (!sysA || !sysB) return true
  return sysA === sysB
}

function sameBody(a: Location, b: Location): boolean {
  return localKey(a) === localKey(b)
}

/**
 * Local hauls stay on one world. A moon is not its planet.
 * When the catalog only stored the star system, use the city/station's planet.
 */
function localKey(loc: Location): string {
  const body = normalizeBody(loc.body)
  const grouped = planetGroup(body)
  if (grouped !== 'Stanton' && grouped !== 'Pyro') return body.toLowerCase()
  const worlds = planetTags(loc)
  const planets = worlds.filter((tag) => !isMoon(tag))
  if (planets.length) return planets[0].toLowerCase()
  if (worlds.length) return worlds[0].toLowerCase()
  return (loc.system || body).toLowerCase()
}

function samePlanet(a: Location, b: Location): boolean {
  const pa = planetTags(a)
  const pb = planetTags(b)
  if (pa.length && pb.length) return pa.some((tag) => pb.includes(tag))
  return sameSystem(a, b)
}

function planetTags(loc: Location): string[] {
  return locationBodies(loc).filter((tag) => !SYSTEM_TAGS.has(tag))
}
