import { HAUL_RANKS, HAUL_TYPES } from '../lib/haulTypes'
import type { Location, Ship } from '../types'

export { HAUL_RANKS, HAUL_TYPES } from '../lib/haulTypes'

/** Known stations missing coords in the SuperCargo snapshot (Gm). */
export const LOCATION_COORD_OVERRIDES: Record<
  string,
  { x: number; y: number; z: number; system: string; body: string }
> = {
  // Pyro II (Monox) L4 — approximate so Checkmate isn't dropped from the catalog
  'Checkmate Station': {
    x: 14.5,
    y: 18.2,
    z: 0.003,
    system: 'pyro',
    body: 'Pyro II',
  },
}

const UEX_BASE = 'https://api.uexcorp.uk/2.0'
/** Curated UEX terminals + scunpacked coords (same source SuperCargo syncs). */
const LOCATIONS_URL =
  'https://cdn.jsdelivr.net/gh/AquatikJustice/SuperCargo@main/data/uex/locations.json'

interface UexVehicle {
  id: number
  name: string
  name_full: string
  company_name: string | null
  scu: number
  is_cargo?: number
  is_spaceship?: number
  is_ground_vehicle?: number
  container_sizes?: string
}

interface UexCommodity {
  id: number
  name: string
  code: string
  kind: string
  is_available?: number
  is_visible?: number
}

export interface CommodityInfo {
  name: string
  /** Normalized category / kind from UEX */
  kind: string
}

function normalizeCommodityKind(kind: string | null | undefined): string {
  const raw = (kind || 'Other').trim() || 'Other'
  const key = raw.toLowerCase()
  const aliases: Record<string, string> = {
    'man-made': 'Man-Made',
    minteral: 'Mineral',
    mineral: 'Mineral',
    organics: 'Organics',
    organic: 'Organics',
    medicine: 'Medical',
    medical: 'Medical',
  }
  return aliases[key] ?? raw
}

interface UexApiLocation {
  name: string
  code: string
  maxContainerSize?: number
  uexId?: number
  hasElevator?: boolean
  x?: number
  y?: number
  z?: number
  system?: string
  operator?: string
  body?: string
}

interface UexTerminal {
  name: string
  space_station_name?: string | null
  outpost_name?: string | null
  city_name?: string | null
  has_loading_dock?: number
}

async function uexGet<T>(path: string): Promise<T[]> {
  const res = await fetch(`${UEX_BASE}${path}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`UEX ${path} failed (${res.status})`)
  const json = (await res.json()) as { status: string; data?: T[]; message?: string }
  if (json.status !== 'ok' || !Array.isArray(json.data)) {
    throw new Error(json.message || `UEX ${path} returned ${json.status}`)
  }
  return json.data
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Cargo-capable ships from UEX /vehicles */
export async function fetchShips(): Promise<Ship[]> {
  const vehicles = await uexGet<UexVehicle>('/vehicles')
  const ships = vehicles
    .filter((v) => (v.scu ?? 0) > 0 && !v.is_ground_vehicle)
    .map((v) => ({
      id: String(v.id),
      name: v.name_full || v.name,
      manufacturer: v.company_name || 'Unknown',
      cargoScu: Math.round(Number(v.scu) || 0),
      containerSizes: (v.container_sizes || '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    }))
    .filter((s) => s.cargoScu > 0)
    .sort((a, b) => a.name.localeCompare(b.name))

  // Deduplicate by name keeping highest SCU
  const byName = new Map<string, Ship>()
  for (const s of ships) {
    const prev = byName.get(s.name)
    if (!prev || s.cargoScu > prev.cargoScu) byName.set(s.name, s)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Commodities with category for the split picker */
export async function fetchCommodities(): Promise<CommodityInfo[]> {
  const rows = await uexGet<UexCommodity>('/commodities')
  return rows
    .filter((c) => c.is_visible !== 0 && c.name)
    .map((c) => ({
      name: c.name.trim(),
      kind: normalizeCommodityKind(c.kind),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Normalize place names for matching UEX terminals ↔ catalog locations. */
function placeMatchKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/^admin\s*-\s*/i, '')
    .replace(/^cargo\s+services\s*-\s*/i, '')
    .replace(/^landing\s+services\s*-\s*/i, '')
    .replace(/\s+station$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Places UEX marks with an exterior loading dock (`has_loading_dock`).
 * Soft-fails to empty set so catalog coords still load if UEX is down.
 */
async function fetchUexLoadingDockKeys(): Promise<Set<string>> {
  try {
    const terminals = await uexGet<UexTerminal>('/terminals')
    const keys = new Set<string>()
    for (const t of terminals) {
      if (!t.has_loading_dock) continue
      for (const raw of [t.space_station_name, t.outpost_name, t.city_name, t.name]) {
        if (!raw?.trim()) continue
        const k = placeMatchKey(raw)
        if (k.length >= 3) keys.add(k)
      }
    }
    return keys
  } catch {
    return new Set()
  }
}

function hasUexLoadingDock(locationName: string, dockKeys: Set<string>): boolean {
  // UEX marks Nyx Gateway (Stanton) but leaves (Pyro) all zeros — same station type
  if (/nyx\s*gateway/i.test(locationName)) return true
  const k = placeMatchKey(locationName)
  if (!k) return false
  if (dockKeys.has(k)) return true
  for (const d of dockKeys) {
    if (d.length < 4 || k.length < 4) continue
    if (k === d || k.startsWith(`${d} `) || d.startsWith(`${k} `)) return true
  }
  return false
}

/**
 * Hauling locations with starmap coords (Gm = meters / 1e9).
 * Coords from SuperCargo snapshot; exterior dock flag from live UEX terminals.
 */
export async function fetchLocations(): Promise<Location[]> {
  const [res, dockKeys] = await Promise.all([
    fetch(LOCATIONS_URL, { headers: { Accept: 'application/json' } }),
    fetchUexLoadingDockKeys(),
  ])
  if (!res.ok) throw new Error(`Locations fetch failed (${res.status})`)
  const json = (await res.json()) as { locations?: UexApiLocation[] }
  const rows = json.locations ?? []

  const mapped: Location[] = []
  for (const l of rows) {
    if (!l.name) continue
    const override = LOCATION_COORD_OVERRIDES[l.name]
    const hasCoords = l.x != null && l.y != null
    if (!hasCoords && !override) continue

    const system =
      (override?.system || l.system || '').toLowerCase() || 'unknown'
    const body =
      override?.body ||
      l.body ||
      l.operator ||
      (system === 'pyro' ? 'Pyro' : system === 'stanton' ? 'Stanton' : system)

    mapped.push({
      id: slug(l.code || l.name),
      name: l.name,
      shortName: shortName(l),
      body,
      type: inferType(l.name),
      system,
      x: override ? override.x : Number(l.x) / 1e9,
      y: override ? override.y : Number(l.y) / 1e9,
      z: override ? override.z : Number(l.z ?? 0) / 1e9,
      aliases: [l.code, l.name, l.operator].filter(Boolean) as string[],
      hasExteriorElevator: hasUexLoadingDock(l.name, dockKeys),
    })
  }

  return mapped.sort((a, b) => a.name.localeCompare(b.name))
}

function shortName(l: UexApiLocation): string {
  if (l.code && l.code !== l.name && l.code.length <= 24) return l.code
  const trimmed = l.name
    .replace(/\s+Station$/i, '')
    .replace(/^Admin\s*-\s*/i, '')
  return trimmed.length > 28 ? trimmed.slice(0, 26) + '…' : trimmed
}

function inferType(name: string): Location['type'] {
  if (/L[1-5]\b/i.test(name)) return 'rest'
  if (/outpost|hdms|mining|research/i.test(name)) return 'outpost'
  if (/station|harbor|point|hex|olisar|tressler|seraphim|baijini|everus|ruin/i.test(name)) {
    return 'station'
  }
  if (/lorville|area\s*18|orison|new babbage/i.test(name)) return 'city'
  return 'landing'
}

export function buildMissionNameOptions(destinations: string[]): string[] {
  const dests = destinations.length ? destinations : ['Ruin Station']
  const out: string[] = []
  for (const rank of HAUL_RANKS) {
    for (const haul of HAUL_TYPES) {
      // Sample a few dests so the list stays usable
      for (const dest of dests.slice(0, 12)) {
        out.push(`${rank} | ${haul} | to ${dest}`)
      }
    }
  }
  return out
}
