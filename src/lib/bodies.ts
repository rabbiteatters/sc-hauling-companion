/**
 * Moon → parent planet. Filters are two-level: planet + moons.
 * Spaceports silently match both their planet and the star system (not listed as chips).
 */
const MOON_TO_PLANET: Record<string, string> = {
  // Hurston
  arial: 'Hurston',
  aberdeen: 'Hurston',
  magda: 'Hurston',
  ita: 'Hurston',
  // Crusader
  cellin: 'Crusader',
  daymar: 'Crusader',
  yela: 'Crusader',
  // ArcCorp
  lyria: 'ArcCorp',
  wala: 'ArcCorp',
  // microTech
  calliope: 'microTech',
  clio: 'microTech',
  euterpe: 'microTech',
}

/** Canonical display names for known moons under each planet. */
const PLANET_MOONS: Record<string, string[]> = {
  Hurston: ['Arial', 'Aberdeen', 'Magda', 'Ita'],
  Crusader: ['Cellin', 'Daymar', 'Yela'],
  ArcCorp: ['Lyria', 'Wala'],
  microTech: ['Calliope', 'Clio', 'Euterpe'],
}

/** L-point / lagrange prefix → home planet */
const LAGRANGE_PLANET: { re: RegExp; planet: string }[] = [
  { re: /\bARC-L\d/i, planet: 'ArcCorp' },
  { re: /\bCRU-L\d/i, planet: 'Crusader' },
  { re: /\bHUR-L\d/i, planet: 'Hurston' },
  { re: /\bMIC-L\d/i, planet: 'microTech' },
]

/** Named stations / cities → home planet (filter membership only). */
const SPACEPORT_PLANET: { re: RegExp; planet: string }[] = [
  { re: /everus/i, planet: 'Hurston' },
  { re: /lorville/i, planet: 'Hurston' },
  { re: /baijini/i, planet: 'ArcCorp' },
  { re: /area\s*18/i, planet: 'ArcCorp' },
  { re: /seraphim/i, planet: 'Crusader' },
  { re: /olisar/i, planet: 'Crusader' },
  { re: /grim\s*hex|grimhex/i, planet: 'Crusader' },
  { re: /orison/i, planet: 'Crusader' },
  { re: /tressler/i, planet: 'microTech' },
  { re: /new\s*babbage/i, planet: 'microTech' },
]

/** Canonical planet label for a body (moons map to parent). */
export function planetGroup(body: string): string {
  const raw = normalizeBody(body)
  const key = raw.toLowerCase()
  if (MOON_TO_PLANET[key]) return MOON_TO_PLANET[key]
  if (key === 'microtech' || key === 'micro tech') return 'microTech'
  if (key === 'arccorp' || key === 'arc corp') return 'ArcCorp'
  return raw
}

export function normalizeBody(body: string): string {
  return (body || 'Unknown').trim() || 'Unknown'
}

/** True when this body is a moon of some planet. */
export function isMoon(body: string): boolean {
  return Boolean(MOON_TO_PLANET[normalizeBody(body).toLowerCase()])
}

export function systemBodyLabel(system?: string): string | undefined {
  if (!system) return undefined
  const s = system.toLowerCase()
  if (s === 'stanton') return 'Stanton'
  if (s === 'pyro') return 'Pyro'
  return s.replace(/^./, (c) => c.toUpperCase())
}

export type LocBodyRef = {
  id?: string
  name: string
  shortName?: string
  body: string
  system?: string
  type?: string
}

/**
 * Body tags for filtering. Spaceports match their planet + star system,
 * without adding extra chips in the planet dropdown.
 */
export function locationBodies(loc: LocBodyRef): string[] {
  const set = new Set<string>()
  const primary = normalizeBody(loc.body)
  const primaryPlanet = planetGroup(primary)
  // If catalog body is the star system (common for L-points), don't treat it as a planet world
  if (primaryPlanet !== 'Stanton' && primaryPlanet !== 'Pyro') {
    set.add(canonicalBodyName(primary, primaryPlanet))
    set.add(primaryPlanet)
  } else {
    set.add(primaryPlanet)
  }

  const system = systemBodyLabel(loc.system)
  if (system) set.add(system)

  const text = `${loc.name} ${loc.shortName ?? ''} ${loc.id ?? ''}`

  for (const { re, planet } of LAGRANGE_PLANET) {
    if (re.test(text)) {
      set.add(planet)
      if (system) set.add(system)
    }
  }

  for (const { re, planet } of SPACEPORT_PLANET) {
    if (re.test(text)) {
      set.add(planet)
      if (system) set.add(system)
    }
  }

  return [...set]
}

export type PlanetBranch = {
  planet: string
  /** Planet + moons only (spaceports are not listed here) */
  bodies: string[]
  moons: string[]
}

function canonicalBodyName(body: string, planet: string): string {
  const key = normalizeBody(body).toLowerCase()
  if (key === planet.toLowerCase()) return planet
  const known = PLANET_MOONS[planet]?.find((m) => m.toLowerCase() === key)
  if (known) return known
  const fromMap = MOON_TO_PLANET[key]
  if (fromMap) {
    const moon = PLANET_MOONS[fromMap]?.find((m) => m.toLowerCase() === key)
    if (moon) return moon
  }
  return normalizeBody(body)
}

/** Build planet → moon branches. Known moons always filled in. */
export function buildPlanetBranches(bodies: string[]): PlanetBranch[] {
  const byPlanet = new Map<string, Set<string>>()
  for (const raw of bodies) {
    const body = normalizeBody(raw)
    const planet = planetGroup(body)
    // Don't create filter trees from raw star-system body tags alone
    if (planet === 'Stanton' || planet === 'Pyro') {
      let set = byPlanet.get(planet)
      if (!set) {
        set = new Set()
        byPlanet.set(planet, set)
      }
      set.add(planet)
      continue
    }
    let set = byPlanet.get(planet)
    if (!set) {
      set = new Set()
      byPlanet.set(planet, set)
    }
    set.add(canonicalBodyName(body, planet))
  }

  for (const [planet, set] of byPlanet) {
    if (planet === 'Stanton' || planet === 'Pyro') {
      set.add(planet)
      continue
    }
    set.add(planet)
    for (const moon of PLANET_MOONS[planet] ?? []) set.add(moon)
  }

  return [...byPlanet.entries()]
    .map(([planet, set]) => {
      const list = [...set].map((b) => canonicalBodyName(b, planet))
      const unique = [...new Set(list)]
      if (planet === 'Stanton' || planet === 'Pyro') {
        return { planet, bodies: [planet], moons: [] as string[] }
      }
      const moons = (PLANET_MOONS[planet] ?? []).filter((m) =>
        unique.some((b) => b.toLowerCase() === m.toLowerCase()),
      )
      const extraMoons = unique.filter(
        (b) => isMoon(b) && !moons.some((m) => m.toLowerCase() === b.toLowerCase()),
      )
      const allMoons = [...moons, ...extraMoons].sort((a, b) => a.localeCompare(b))
      const planetBodies = unique
        .filter((b) => !isMoon(b))
        .sort((a, b) => {
          if (a === planet) return -1
          if (b === planet) return 1
          return a.localeCompare(b)
        })
      return {
        planet,
        bodies: [...planetBodies, ...allMoons],
        moons: allMoons,
      }
    })
    .sort((a, b) => a.planet.localeCompare(b.planet))
}

export function listPlanetGroups(bodies: string[]): string[] {
  return buildPlanetBranches(bodies).map((b) => b.planet)
}
