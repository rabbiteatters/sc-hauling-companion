import { coerceMissions } from './appCache'
import type { CapacityMode } from './appCache'
import type { Mission, OptimizedRoute, RouteStop, StopKind } from '../types'

const SESSION_KEY = 'sc-hauling-route-session-v1'

export interface ShareSnapshot {
  capacityMode: CapacityMode
  shipId: string
  shipName: string
  customScu: number
  capacityScu: number
  startId: string
  missions: Mission[]
  route: OptimizedRoute | null
  done: number[]
  step: number
}

export interface RouteSession {
  route: OptimizedRoute | null
  done: number[]
  step: number
}

export function hashHasShare(hash = typeof location === 'undefined' ? '' : location.hash): boolean {
  return /^#r\.[01]\./.test(hash)
}

export function loadRouteSession(): RouteSession {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return { route: null, done: [], step: 0 }
    const parsed = JSON.parse(raw) as unknown
    const route = sanitizeRoute(parsed && typeof parsed === 'object' ? (parsed as { route?: unknown }).route : null)
    const done = sanitizeDone(parsed && typeof parsed === 'object' ? (parsed as { done?: unknown }).done : [])
    const step = sanitizeStep(parsed && typeof parsed === 'object' ? (parsed as { step?: unknown }).step : 0)
    if (!route) return { route: null, done: [], step: 0 }
    return { route, done, step }
  } catch {
    return { route: null, done: [], step: 0 }
  }
}

export function saveRouteSession(session: RouteSession): void {
  try {
    if (!session.route) {
      localStorage.removeItem(SESSION_KEY)
      return
    }
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        v: 1,
        route: session.route,
        done: session.done,
        step: session.step,
      }),
    )
  } catch {
    // Quota / private mode — ignore
  }
}

export async function buildShareUrl(snapshot: ShareSnapshot): Promise<string> {
  const json = JSON.stringify({
    v: 1,
    capacityMode: snapshot.capacityMode,
    shipId: snapshot.shipId,
    shipName: snapshot.shipName,
    customScu: snapshot.customScu,
    capacityScu: snapshot.capacityScu,
    startId: snapshot.startId,
    missions: snapshot.missions,
    route: snapshot.route,
    done: snapshot.done,
    step: snapshot.step,
  })
  let marker = '0'
  let bytes: Uint8Array
  try {
    bytes = await deflate(json)
    marker = '1'
  } catch {
    bytes = new TextEncoder().encode(json)
  }
  const url = new URL(import.meta.env.BASE_URL, location.origin)
  url.hash = `r.${marker}.${bytesToBase64Url(bytes)}`
  return url.href
}

export async function readShareHash(hash: string): Promise<ShareSnapshot | null> {
  const match = /^#r\.([01])\.(.+)$/.exec(hash)
  if (!match) return null
  try {
    const bytes = base64UrlToBytes(match[2])
    const json =
      match[1] === '1' ? await inflate(bytes) : new TextDecoder().decode(bytes)
    return parseSnapshot(JSON.parse(json))
  } catch {
    return null
  }
}

function parseSnapshot(raw: unknown): ShareSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const missions = coerceMissions(o.missions)
  if (!missions.length) return null
  const capacityMode: CapacityMode = o.capacityMode === 'custom' ? 'custom' : 'ship'
  return {
    capacityMode,
    shipId: typeof o.shipId === 'string' ? o.shipId : '',
    shipName: typeof o.shipName === 'string' ? o.shipName : '',
    customScu: Math.max(0, finite(o.customScu, 0)),
    capacityScu: Math.max(0, finite(o.capacityScu, 0)),
    startId: typeof o.startId === 'string' ? o.startId : '',
    missions,
    route: sanitizeRoute(o.route),
    done: sanitizeDone(o.done),
    step: sanitizeStep(o.step),
  }
}

function sanitizeRoute(raw: unknown): OptimizedRoute | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<OptimizedRoute>
  if (!Array.isArray(r.stops) || r.stops.length === 0) return null
  const stops = r.stops.map(sanitizeStop).filter((s): s is RouteStop => s != null)
  if (!stops.length) return null
  const method =
    r.method === 'exact' ||
    r.method === 'heuristic' ||
    r.method === 'multitrip' ||
    r.method === 'following'
      ? r.method
      : 'heuristic'
  return {
    selectedMissionIds: stringList(r.selectedMissionIds),
    skippedMissionIds: stringList(r.skippedMissionIds),
    stops,
    totalDistance: Math.max(0, finite(r.totalDistance, 0)),
    totalReward: finite(r.totalReward, 0),
    totalCargoScu: Math.max(0, finite(r.totalCargoScu, 0)),
    capacityScu: Math.max(0, finite(r.capacityScu, 0)),
    tripCount: Math.max(1, Math.round(finite(r.tripCount, 1))),
    method,
    peakLoad: Math.max(0, finite(r.peakLoad, 0)),
  }
}

function sanitizeStop(raw: unknown): RouteStop | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<RouteStop>
  if (s.kind !== 'pickup' && s.kind !== 'dropoff') return null
  if (typeof s.locationId !== 'string' || !s.locationId) return null
  if (typeof s.missionId !== 'string' || !s.missionId) return null
  const kind: StopKind = s.kind
  const boxes = Array.isArray(s.boxes)
    ? s.boxes.map((n) => finite(n, 0)).filter((n) => n > 0)
    : undefined
  return {
    missionId: s.missionId,
    missionName: typeof s.missionName === 'string' ? s.missionName : '',
    kind,
    locationId: s.locationId,
    locationName: typeof s.locationName === 'string' ? s.locationName : s.locationId,
    cargoDelta: finite(s.cargoDelta, 0),
    cargoAfter: finite(s.cargoAfter, 0),
    legDistance: Math.max(0, finite(s.legDistance, 0)),
    trip: Math.max(0, Math.round(finite(s.trip, 0))),
    ...(typeof s.stopRemaining === 'number' && Number.isFinite(s.stopRemaining)
      ? { stopRemaining: s.stopRemaining }
      : {}),
    ...(boxes && boxes.length ? { boxes } : {}),
    ...(typeof s.commodity === 'string' && s.commodity ? { commodity: s.commodity } : {}),
    ...(s.confirmed ? { confirmed: true } : {}),
  }
}

function sanitizeDone(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<number>()
  for (const n of raw) {
    if (!Number.isInteger(n) || (n as number) < 0) continue
    seen.add(n as number)
  }
  return [...seen]
}

function sanitizeStep(raw: unknown): number {
  const n = Math.round(finite(raw, 0))
  return n > 0 ? n : 0
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
}

function finite(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(token: string): Uint8Array {
  const pad = token.length % 4 === 0 ? '' : '='.repeat(4 - (token.length % 4))
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return await new Response(stream).text()
}
