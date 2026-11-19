import { LOCATION_IDS } from '../data/locationIds'
import { coerceMissions } from './appCache'
import type { CapacityMode } from './appCache'
import { buildAutoMissionName, HAUL_RANKS, HAUL_TYPES } from './haulTypes'
import { objectiveRouteParts } from './objectives'
import { formatDemoMissionCode, formatMissionCode, sanitizeBoxes, scuToBoxes } from './spread'
import type { Mission, MissionObjective, OptimizedRoute, RouteStop, StopKind } from '../types'

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
  return /^#r\.[0-5]\./.test(hash)
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
  const url = new URL(import.meta.env.BASE_URL, location.origin)
  url.hash = await encodeShareToken(snapshot)
  return url.href
}

/** Compact hash payload. The route is rebuilt on open, so the link stays short. */
export async function encodeShareToken(snapshot: ShareSnapshot): Promise<string> {
  const raw = packBinary(snapshot)
  let marker = '4'
  let bytes: Uint8Array<ArrayBufferLike> = raw
  try {
    const packed = await deflateBytes(raw)
    if (packed.length < raw.length) {
      marker = '5'
      bytes = packed
    }
  } catch {
    // Keep the uncompressed payload.
  }
  return `r.${marker}.${bytesToBase64Url(bytes)}`
}

export async function readShareHash(hash: string): Promise<ShareSnapshot | null> {
  const match = /^#r\.([0-5])\.(.+)$/.exec(hash)
  if (!match) return null
  try {
    const bytes = base64UrlToBytes(match[2])
    const marker = match[1]
    if (marker === '4' || marker === '5') {
      const packed = marker === '5' ? await inflateBytes(bytes) : bytes
      return parseSnapshot(unpackBinary(packed))
    }
    const json =
      marker === '1' || marker === '2' ? await inflate(bytes) : new TextDecoder().decode(bytes)
    const parsed = JSON.parse(json) as unknown
    return parseSnapshot(marker === '2' || marker === '3' ? unpackSnapshot(parsed) : parsed)
  } catch {
    return null
  }
}

function missionObjectives(m: Mission): MissionObjective[] {
  if (m.objectives?.length) return m.objectives
  return [
    {
      id: 'o',
      commodity: m.commodity ?? '',
      totalScu: m.totalScu,
      pickups: m.pickups ?? [],
      dropoffs: m.dropoffs ?? [],
    },
  ]
}

/** Title the share can omit and rebuild from the contract fields. */
export function missionShareTitle(m: Mission): string {
  const objectives = missionObjectives(m)
  const route = objectiveRouteParts(objectives)
  return buildAutoMissionName({
    giver: m.giver,
    rank: m.rank,
    haulType: m.haulType,
    from: route.from,
    to: route.to,
    pickupCount: route.pickupCount,
    dropoffCount: route.dropoffCount,
    demo: m.source === 'demo',
  })
}

/** Fill titles that were left out of a share, once location names are known. */
export function withAutoMissionNames(missions: Mission[]): Mission[] {
  let changed = false
  const next = missions.map((m) => {
    if (!m.nameAuto) return m
    const name = missionShareTitle(m)
    if (!name || name === m.name) return m
    changed = true
    return { ...m, name }
  })
  return changed ? next : missions
}

const LOC_SENTINEL = 32767
const locIndex = new Map(LOCATION_IDS.map((id, index) => [id, index]))

const F_CUSTOM = 1
const F_SHIP_ID = 2
const F_SHIP_NAME = 4
const F_DONE = 8
const F_STEP = 16
const F_SHIP_NUM = 32

const M_DISABLED = 1
const M_DEMO = 2
const M_OCR = 4
const M_NAME = 8
const M_CODE = 16

class ShareWriter {
  private bytes: number[] = []
  private pool = new Map<string, number>()
  private text = new TextEncoder()

  u8(n: number) {
    this.bytes.push(n & 255)
  }

  vu(n: number) {
    let v = Math.max(0, Math.floor(n))
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    this.u8(v)
  }

  str(s: string) {
    const prev = this.pool.get(s)
    if (prev != null) {
      this.vu((prev << 1) | 1)
      return
    }
    const raw = this.text.encode(s)
    this.vu(raw.length << 1)
    for (const byte of raw) this.u8(byte)
    this.pool.set(s, this.pool.size)
  }

  loc(id: string) {
    const index = locIndex.get(id)
    if (index != null && index < LOC_SENTINEL) this.vu(index)
    else {
      this.vu(LOC_SENTINEL)
      this.str(id)
    }
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

class ShareReader {
  private i = 0
  private pool: string[] = []
  private bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  u8(): number {
    if (this.i >= this.bytes.length) throw new Error('short')
    return this.bytes[this.i++]
  }

  vu(): number {
    let n = 0
    let shift = 0
    for (let k = 0; k < 5; k++) {
      const byte = this.u8()
      n += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) return n
      shift += 7
    }
    throw new Error('varint')
  }

  str(): string {
    const n = this.vu()
    if (n & 1) return this.pool[n >> 1] ?? ''
    const len = n >> 1
    if (len > 10000 || this.i + len > this.bytes.length) throw new Error('str')
    const s = new TextDecoder().decode(this.bytes.subarray(this.i, this.i + len))
    this.i += len
    this.pool.push(s)
    return s
  }

  loc(): string {
    const n = this.vu()
    if (n === LOC_SENTINEL) return this.str()
    const id = LOCATION_IDS[n]
    if (!id) throw new Error('loc')
    return id
  }
}

function packBinary(snapshot: ShareSnapshot): Uint8Array {
  const w = new ShareWriter()
  const custom = snapshot.capacityMode === 'custom'
  const shipId = custom ? '' : snapshot.shipId
  const shipName = custom ? '' : snapshot.shipName
  const shipNum = /^\d+$/.test(shipId)
  const done = snapshot.done.filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b)
  const step = sanitizeStep(snapshot.step)
  let flags = 0
  if (custom) flags |= F_CUSTOM
  if (shipId) flags |= F_SHIP_ID
  if (shipName) flags |= F_SHIP_NAME
  if (done.length) flags |= F_DONE
  if (step > 0) flags |= F_STEP
  if (shipNum) flags |= F_SHIP_NUM

  const hasLoadNote = snapshot.missions.some((m) =>
    missionObjectives(m).some((o) => Boolean(o.loadNote?.trim())),
  )
  const hasCustomBoxes = snapshot.missions.some((m) =>
    missionObjectives(m).some((o) =>
      o.pickups.some((p) => {
        const boxes = sanitizeBoxes(p.boxes, p.scu, m.maxUnitScu)
        if (!boxes) return false
        const greedy = [...scuToBoxes(p.scu, m.maxUnitScu)].sort((a, b) => b - a)
        const chosen = [...boxes].sort((a, b) => b - a)
        return chosen.length !== greedy.length || chosen.some((size, i) => size !== greedy[i])
      }),
    ),
  )
  w.u8(hasCustomBoxes ? 3 : hasLoadNote ? 2 : 1)
  w.u8(flags)
  w.vu(custom ? snapshot.customScu : snapshot.capacityScu)
  if (shipId) {
    if (shipNum) w.vu(Number(shipId))
    else w.str(shipId)
  }
  if (shipName) w.str(shipName)
  w.loc(snapshot.startId)
  w.vu(snapshot.missions.length)

  snapshot.missions.forEach((m, index) => {
    const haul = Math.max(0, HAUL_TYPES.indexOf(m.haulType))
    const listed = m.rank ? HAUL_RANKS.indexOf(m.rank as (typeof HAUL_RANKS)[number]) : -1
    const rankNibble = listed >= 0 ? listed : m.rank ? 15 : 7
    const title = missionShareTitle(m)
    const customName = !title || m.name !== title
    const expected =
      m.source === 'demo' ? formatDemoMissionCode(index + 1) : formatMissionCode(index + 1)
    const customCode = m.code !== expected
    let meta = 0
    if (m.enabled === false) meta |= M_DISABLED
    if (m.source === 'demo') meta |= M_DEMO
    else if (m.source === 'ocr') meta |= M_OCR
    if (customName) meta |= M_NAME
    if (customCode) meta |= M_CODE
    w.u8((haul & 15) | (rankNibble << 4))
    w.u8(meta)
    w.vu(m.maxUnitScu)
    w.str(m.giver ?? '')
    w.vu(m.rewardAuec && m.rewardAuec > 0 ? m.rewardAuec : 0)
    if (rankNibble === 15) w.str(m.rank ?? '')
    if (customName) w.str(m.name)
    if (customCode) w.str(m.code)
    const objectives = missionObjectives(m)
    w.vu(objectives.length)
    for (const o of objectives) {
      w.str(o.commodity)
      if (hasLoadNote || hasCustomBoxes) w.str(o.loadNote?.trim() ?? '')
      w.vu(o.totalScu)
      w.vu(o.pickups.length)
      for (const p of o.pickups) {
        w.loc(p.locationId)
        w.vu((Math.max(0, Math.round(p.scu)) << 1) | (p.confirmed ? 1 : 0))
        if (hasCustomBoxes) {
          const boxes = sanitizeBoxes(p.boxes, p.scu, m.maxUnitScu) ?? []
          w.vu(boxes.length)
          for (const size of boxes) w.vu(size)
        }
      }
      w.vu(o.dropoffs.length)
      for (const d of o.dropoffs) {
        w.loc(d.locationId)
        w.vu(Math.max(0, Math.round(d.scu)))
      }
    }
  })

  if (done.length) {
    w.vu(done.length)
    for (const n of done) w.vu(n)
  }
  if (step > 0) w.vu(step)
  return w.toUint8Array()
}

function unpackBinary(bytes: Uint8Array): unknown {
  const r = new ShareReader(bytes)
  const version = r.u8()
  if (version !== 1 && version !== 2 && version !== 3) throw new Error('version')
  const flags = r.u8()
  const custom = (flags & F_CUSTOM) !== 0
  const scu = r.vu()
  let shipId = ''
  let shipName = ''
  if (!custom && (flags & F_SHIP_ID) !== 0) {
    shipId = (flags & F_SHIP_NUM) !== 0 ? String(r.vu()) : r.str()
  }
  if (!custom && (flags & F_SHIP_NAME) !== 0) shipName = r.str()
  const startId = r.loc()
  const missionCount = r.vu()
  if (missionCount > 200) throw new Error('missions')
  const missions = []
  for (let index = 0; index < missionCount; index++) missions.push(readMission(r, index, version))
  const done = []
  if (flags & F_DONE) {
    const count = r.vu()
    if (count > 500) throw new Error('done')
    for (let i = 0; i < count; i++) done.push(r.vu())
  }
  const step = flags & F_STEP ? r.vu() : 0
  return {
    capacityMode: custom ? 'custom' : 'ship',
    shipId,
    shipName,
    customScu: custom ? scu : 0,
    capacityScu: scu,
    startId,
    missions,
    done,
    step,
  }
}

function readMission(r: ShareReader, index: number, version: number): Record<string, unknown> {
  const haulRank = r.u8()
  const meta = r.u8()
  const maxUnitScu = r.vu()
  const giver = r.str()
  const rewardAuec = r.vu()
  const rankNibble = haulRank >> 4
  const rank =
    rankNibble === 15 ? r.str() : rankNibble < HAUL_RANKS.length ? HAUL_RANKS[rankNibble] : undefined
  const storedName = meta & M_NAME ? r.str() : ''
  const source = meta & M_DEMO ? 'demo' : meta & M_OCR ? 'ocr' : 'manual'
  const code =
    meta & M_CODE
      ? r.str()
      : source === 'demo'
        ? formatDemoMissionCode(index + 1)
        : formatMissionCode(index + 1)
  const haul = HAUL_TYPES[haulRank & 15] ?? HAUL_TYPES[0]
  const objCount = r.vu()
  if (objCount > 20) throw new Error('objectives')
  const objectives = []
  for (let oi = 0; oi < objCount; oi++) objectives.push(readObjective(r, oi, version))
  const draft = {
    giver,
    rank,
    haulType: haul,
    source,
    objectives,
  } as unknown as Mission
  const auto = missionShareTitle(draft)
  return {
    id: `m${index + 1}`,
    code,
    name: storedName || auto || 'Haul',
    haulType: haul,
    ...(rank ? { rank } : {}),
    ...(giver ? { giver } : {}),
    ...(rewardAuec > 0 ? { rewardAuec } : {}),
    maxUnitScu,
    totalScu: 1,
    objectives,
    source,
    ...(meta & M_DISABLED ? { enabled: false } : {}),
    ...(!storedName ? { nameAuto: true } : {}),
  }
}

function readObjective(r: ShareReader, index: number, version: number): Record<string, unknown> {
  const commodity = r.str()
  const loadNote = version >= 2 ? r.str().trim().slice(0, 80) : ''
  const totalScu = r.vu()
  const pickCount = r.vu()
  if (pickCount > 32) throw new Error('pickups')
  const pickups = []
  for (let i = 0; i < pickCount; i++) {
    const locationId = r.loc()
    const packed = r.vu()
    const scu = packed >> 1
    let boxes: number[] | undefined
    if (version >= 3) {
      const count = r.vu()
      if (count > 64) throw new Error('boxes')
      const list: number[] = []
      for (let b = 0; b < count; b++) list.push(r.vu())
      boxes = sanitizeBoxes(list, scu)
    }
    if (!locationId) continue
    pickups.push({
      locationId,
      scu,
      ...(packed & 1 ? { confirmed: true } : {}),
      ...(boxes ? { boxes } : {}),
    })
  }
  const dropCount = r.vu()
  if (dropCount > 32) throw new Error('dropoffs')
  const dropoffs = []
  for (let i = 0; i < dropCount; i++) {
    const locationId = r.loc()
    const scu = r.vu()
    if (!locationId) continue
    dropoffs.push({ locationId, scu })
  }
  return {
    id: `o${index + 1}`,
    commodity,
    totalScu,
    pickups,
    dropoffs,
    ...(loadNote ? { loadNote } : {}),
  }
}

function unpackSnapshot(raw: unknown): unknown {
  if (!Array.isArray(raw) || raw[0] !== 2) return raw
  const mode = raw[1] === 1 ? 'custom' : 'ship'
  const scu = finite(raw[4], 0)
  const locs = Array.isArray(raw[6]) ? raw[6].map((id) => String(id ?? '')) : []
  const loc = (i: unknown) => locs[Math.round(finite(i, -1))] ?? ''
  const missions = Array.isArray(raw[7]) ? raw[7].map((item, index) => expandMission(item, index, loc)) : []
  return {
    capacityMode: mode,
    shipId: typeof raw[2] === 'string' ? raw[2] : '',
    shipName: typeof raw[3] === 'string' ? raw[3] : '',
    customScu: mode === 'custom' ? scu : 0,
    capacityScu: scu,
    startId: loc(raw[5]),
    missions,
    done: raw[8],
    step: raw[9],
  }
}

function expandMission(
  raw: unknown,
  index: number,
  loc: (i: unknown) => string,
): Record<string, unknown> {
  const row = Array.isArray(raw) ? raw : []
  const flags = Math.round(finite(row[7], 0))
  const haul = HAUL_TYPES[Math.round(finite(row[2], 0))] ?? HAUL_TYPES[0]
  const rank =
    typeof row[3] === 'string'
      ? row[3]
      : Math.round(finite(row[3], -1)) >= 0
        ? HAUL_RANKS[Math.round(finite(row[3], -1))]
        : undefined
  const objectives = Array.isArray(row[8])
    ? row[8].map((item, oi) => expandObjective(item, oi, loc))
    : []
  return {
    id: `m${index + 1}`,
    code: typeof row[0] === 'string' && row[0] ? row[0] : `C0${index + 1}`,
    name: typeof row[1] === 'string' && row[1] ? row[1] : 'Haul',
    haulType: haul,
    ...(rank ? { rank } : {}),
    giver: typeof row[4] === 'string' ? row[4] : '',
    rewardAuec: finite(row[5], 0),
    maxUnitScu: finite(row[6], 8),
    totalScu: 1,
    objectives,
    source: flags & 2 ? 'demo' : flags & 4 ? 'ocr' : 'manual',
    ...(flags & 1 ? { enabled: false } : {}),
  }
}

function expandObjective(
  raw: unknown,
  index: number,
  loc: (i: unknown) => string,
): Record<string, unknown> {
  const row = Array.isArray(raw) ? raw : []
  const stops = (list: unknown, confirmed: boolean) =>
    Array.isArray(list)
      ? list
          .filter((stop) => Array.isArray(stop))
          .map((stop) => {
            const pair = stop as unknown[]
            const locationId = loc(pair[0])
            if (!locationId) return null
            return {
              locationId,
              scu: finite(pair[1], 0),
              ...(confirmed && pair[2] ? { confirmed: true } : {}),
            }
          })
          .filter((stop) => stop != null)
      : []
  return {
    id: `o${index + 1}`,
    commodity: typeof row[0] === 'string' ? row[0] : '',
    totalScu: finite(row[1], 0),
    pickups: stops(row[2], true),
    dropoffs: stops(row[3], false),
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

async function deflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflateBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return await new Response(stream).text()
}
