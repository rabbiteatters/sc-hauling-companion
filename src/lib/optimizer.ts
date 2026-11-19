/**
 * Capacitated pickup-and-delivery planner.
 * Always routes every mission / location — never skips stops.
 * Splits into trips only when total cargo exceeds hold capacity.
 */

import { legacyMissionToObjectives, missionTotalScu } from './objectives'
import { buildDropoffs, buildStops, DEFAULT_MAX_UNIT_SCU } from './spread'
import { groupRouteByLocation } from './routeGroups'
import { distanceBetween, getLocation, resolveStoredLocation } from '../store/catalog'
import type {
  Mission,
  MissionObjective,
  MissionStop,
  OptimizedRoute,
  RouteStop,
} from '../types'

interface CargoJob {
  id: string
  missionId: string
  missionName: string
  pickupId: string
  dropoffId: string
  scu: number
  commodity?: string
}

/** Cargo already aboard when planning only the rest of a route. */
interface RouteSeed {
  /** Hold that is not represented by a remaining delivery job. */
  loadOffset: number
  preloadedIds: ReadonlySet<string>
}

const EXACT_NODE_MAX = 14
const EXACT_WORK_BUDGET = 1_500_000
/**
 * Extra cost for leaving a hub and coming back.
 * A hub is where one contract is delivered and the next is collected.
 * One stop there beats a shorter tour that crosses back later.
 */
const HUB_REVISIT_PENALTY = 1_000_000

/** 0 / unset hold → unlimited space for routing (no capacity trip splits). */
export function resolveHoldCapacity(capacityScu: number): number {
  return capacityScu > 0 ? capacityScu : Number.POSITIVE_INFINITY
}

export function formatHoldCapacity(capacityScu: number): string {
  return capacityScu > 0 ? `${capacityScu} SCU` : 'Unlimited SCU'
}

/** Point unscanned custom ids at the real station when the name is close enough. */
export function repairMissionLocations(missions: Mission[]): Mission[] {
  let changed = false
  const mapStop = (stop: MissionStop): MissionStop => {
    const custom = stop.locationId.startsWith('custom-')
    if (!custom && getLocation(stop.locationId)) return stop
    const loc = resolveStoredLocation(stop.locationId)
    if (!loc || loc.id === stop.locationId) return stop
    changed = true
    return { ...stop, locationId: loc.id }
  }
  const next = missions.map((m) => ({
    ...m,
    pickups: (m.pickups ?? []).map(mapStop),
    dropoffs: (m.dropoffs ?? []).map(mapStop),
    objectives: m.objectives?.map((o) => ({
      ...o,
      pickups: o.pickups.map(mapStop),
      dropoffs: o.dropoffs.map(mapStop),
    })),
  }))
  return changed ? next : missions
}

export function optimizeRoute(
  missions: Mission[],
  startLocationId: string,
  capacityScu: number,
): OptimizedRoute {
  const ready = repairMissionLocations(missions)
  const reportedCapacity = Math.max(0, capacityScu)
  const hold = resolveHoldCapacity(reportedCapacity)
  if (!getLocation(startLocationId)) return emptyRoute(reportedCapacity, ready)

  const workable = ready.filter((m) => isFeasible(m, hold))
  // Still attempt every mission; infeasible ones are kept but may force multi-trip / partial
  const jobs = expandJobs(workable.length ? workable : ready)
  if (!jobs.length) return emptyRoute(reportedCapacity, ready)

  const planned = planJobs(jobs, startLocationId, hold)
  if (!planned) return emptyRoute(reportedCapacity, ready)

  const reward = ready.reduce((s, m) => {
    const total = missionCargoTotal(m)
    return s + (m.rewardAuec ?? total * 1000)
  }, 0)
  const cargo = ready.reduce((s, m) => s + missionCargoTotal(m), 0)

  return {
    selectedMissionIds: ready.map((m) => m.id),
    skippedMissionIds: [],
    stops: planned.stops,
    totalDistance: planned.totalDistance,
    totalReward: reward,
    totalCargoScu: cargo,
    capacityScu: reportedCapacity,
    tripCount: planned.tripCount,
    method: planned.method,
    peakLoad: planned.peakLoad,
  }
}

function emptyRoute(capacityScu: number, missions: Mission[] = []): OptimizedRoute {
  return {
    selectedMissionIds: missions.map((m) => m.id),
    skippedMissionIds: [],
    stops: [],
    totalDistance: 0,
    totalReward: 0,
    totalCargoScu: 0,
    capacityScu,
    tripCount: 0,
    method: 'heuristic',
    peakLoad: 0,
  }
}

function missionCargoTotal(m: Mission): number {
  const objs = legacyMissionToObjectives(m)
  const sum = missionTotalScu(objs)
  return sum > 0 ? sum : m.totalScu
}

function isFeasible(m: Mission, capacity: number): boolean {
  if (missionCargoTotal(m) <= 0) return false
  // Finite hold must be able to carry at least something; Infinity = unlimited.
  if (Number.isFinite(capacity) && capacity < 1) return false
  const objectives = legacyMissionToObjectives(m)
  if (!objectives.some((o) => o.pickups.length && o.dropoffs.length)) return false
  return objectives.every(
    (o) =>
      o.pickups.every((p) => getLocation(p.locationId)) &&
      o.dropoffs.every((d) => getLocation(d.locationId)),
  )
}

/**
 * Multi-stop sides often keep per-stop SCU at 0 until the user spreads Total.
 * For routing, fill missing side loads from Total (or the other side's sum).
 */
function workingObjectiveStops(
  m: Mission,
  obj: MissionObjective,
): {
  pickups: MissionStop[]
  dropoffs: MissionStop[]
} {
  const pickSum = obj.pickups.reduce((s, p) => s + Math.max(0, p.scu), 0)
  const dropSum = obj.dropoffs.reduce((s, d) => s + Math.max(0, d.scu), 0)
  const total = Math.max(0, Math.round(obj.totalScu) || 0, pickSum, dropSum)
  const maxUnit = m.maxUnitScu || DEFAULT_MAX_UNIT_SCU

  let pickups = obj.pickups
  let dropoffs = obj.dropoffs
  if (obj.pickups.length && pickSum <= 0 && total > 0) {
    pickups = buildStops(
      obj.pickups.map((p) => p.locationId),
      total,
      maxUnit,
    )
  }
  if (obj.dropoffs.length && dropSum <= 0 && total > 0) {
    dropoffs = buildDropoffs(
      obj.dropoffs.map((d) => d.locationId),
      total,
      maxUnit,
    )
  }
  return { pickups, dropoffs }
}

function expandObjectiveJobs(
  m: Mission,
  obj: MissionObjective,
  objIndex: number,
): CargoJob[] {
  const jobs: CargoJob[] = []
  const commodity = obj.commodity.trim() || m.commodity
  const prefix = `${m.id}:o${objIndex}`
  const { pickups, dropoffs } = workingObjectiveStops(m, obj)

  if (pickups.length > 1 && dropoffs.length > 1) {
    const dropTotal = dropoffs.reduce((s, d) => s + Math.max(0, d.scu), 0)
    for (const p of pickups) {
      if (p.scu <= 0) continue
      if (dropTotal <= 0) {
        const dest = dropoffs[0]
        jobs.push({
          id: `${prefix}:${p.locationId}->${dest.locationId}`,
          missionId: m.id,
          missionName: m.name,
          pickupId: p.locationId,
          dropoffId: dest.locationId,
          scu: p.scu,
          commodity,
        })
        continue
      }
      let assigned = 0
      dropoffs.forEach((d, di) => {
        const isLast = di === dropoffs.length - 1
        const share = isLast
          ? Math.max(0, p.scu - assigned)
          : Math.max(
              0,
              Math.round((p.scu * Math.max(0, d.scu)) / dropTotal),
            )
        assigned += share
        if (share <= 0) return
        jobs.push({
          id: `${prefix}:${p.locationId}->${d.locationId}`,
          missionId: m.id,
          missionName: m.name,
          pickupId: p.locationId,
          dropoffId: d.locationId,
          scu: share,
          commodity,
        })
      })
    }
  } else if (pickups.length >= 1 && dropoffs.length === 1) {
    const dest = dropoffs[0].locationId
    for (const p of pickups) {
      if (p.scu <= 0) continue
      jobs.push({
        id: `${prefix}:${p.locationId}->${dest}`,
        missionId: m.id,
        missionName: m.name,
        pickupId: p.locationId,
        dropoffId: dest,
        scu: p.scu,
        commodity,
      })
    }
  } else if (pickups.length === 1 && dropoffs.length >= 1) {
    const src = pickups[0].locationId
    for (const d of dropoffs) {
      if (d.scu <= 0) continue
      jobs.push({
        id: `${prefix}:${src}->${d.locationId}`,
        missionId: m.id,
        missionName: m.name,
        pickupId: src,
        dropoffId: d.locationId,
        scu: d.scu,
        commodity,
      })
    }
  }
  return jobs
}

function expandJobs(missions: Mission[]): CargoJob[] {
  const jobs: CargoJob[] = []
  for (const m of missions) {
    const objectives = legacyMissionToObjectives(m)
    objectives.forEach((obj, i) => {
      jobs.push(...expandObjectiveJobs(m, obj, i))
    })
  }
  return jobs.filter((j) => getLocation(j.pickupId) && getLocation(j.dropoffId))
}

function planJobs(
  jobs: CargoJob[],
  startId: string,
  capacity: number,
  seed?: RouteSeed,
): {
  stops: RouteStop[]
  totalDistance: number
  tripCount: number
  method: OptimizedRoute['method']
  peakLoad: number
} | null {
  if (!seed) {
    const total = jobs.reduce((s, j) => s + j.scu, 0)
    // Unlimited hold (Infinity) or cargo fits → one tour.
    if (!Number.isFinite(capacity) || total <= capacity) {
      const single = solveSingleTour(jobs, startId, capacity)
      if (!single) return null
      return { ...single, tripCount: 1 }
    }
    return solveMultiTrip(jobs, startId, capacity)
  }

  const aboardScu = jobs
    .filter((j) => seed.preloadedIds.has(j.id))
    .reduce((s, j) => s + j.scu, 0)
  const openScu = jobs
    .filter((j) => !seed.preloadedIds.has(j.id))
    .reduce((s, j) => s + j.scu, 0)
  const carried = openScu + aboardScu + seed.loadOffset
  if (!Number.isFinite(capacity) || carried <= capacity) {
    const single = solveSingleTour(jobs, startId, capacity, seed)
    if (!single) return null
    return { ...single, tripCount: 1 }
  }
  return solveMultiTrip(jobs, startId, capacity, seed)
}

function solveSingleTour(
  jobs: CargoJob[],
  startId: string,
  capacity: number,
  seed?: RouteSeed,
): {
  stops: RouteStop[]
  totalDistance: number
  method: 'exact' | 'heuristic'
  peakLoad: number
} | null {
  // Depot is always node 0 (even when start == a pickup/dropoff). Cargo stops are
  // separate nodes so we can leave and return to unload at the starting location.
  const loadOffset = seed?.loadOffset ?? 0
  const { nodes, mapped, start } = buildTourGraph(jobs, startId, seed?.preloadedIds)
  const dist = buildDistMatrix(nodes)
  const n = nodes.length
  const input = {
    n,
    dist,
    capacity,
    start,
    jobs: mapped,
    loadOffset,
    nodes,
    hubs: hubLocationIds(jobs),
  }

  let order: number[] | null = null
  let method: 'exact' | 'heuristic' = 'heuristic'
  if (n <= EXACT_NODE_MAX) {
    const exact = solveExact(input)
    if (exact && exact !== 'too-big') {
      order = exact
      method = 'exact'
    }
  }
  if (!order) {
    order = solveHeuristic(input)
    method = 'heuristic'
  }
  if (!order) return null

  const aboardScu = mapped
    .filter((j) => j.preloaded)
    .reduce((s, j) => s + j.scu, 0)
  const material = materialize(order, nodes, mapped, 0, loadOffset + aboardScu)
  return {
    stops: material.stops,
    totalDistance: material.totalDistance,
    method,
    peakLoad: material.peakLoad,
  }
}

function solveMultiTrip(
  jobs: CargoJob[],
  startId: string,
  capacity: number,
  seed?: RouteSeed,
): {
  stops: RouteStop[]
  totalDistance: number
  tripCount: number
  method: 'multitrip'
  peakLoad: number
} | null {
  const pending = new Set(jobs.map((j) => j.id))
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const allStops: RouteStop[] = []
  let current = startId
  let trip = 0
  let peak = 0
  let guard = 0
  const loadOffset = seed?.loadOffset ?? 0
  let preloadedIds = new Set(seed?.preloadedIds ?? [])

  while (pending.size && guard++ < 200) {
    const remaining = [...pending].map((id) => byId.get(id)!)
    let batch: CargoJob[]
    if (preloadedIds.size) {
      const must = remaining.filter((j) => preloadedIds.has(j.id))
      const open = remaining.filter((j) => !preloadedIds.has(j.id))
      const aboardScu = must.reduce((s, j) => s + j.scu, 0)
      const room = Number.isFinite(capacity)
        ? Math.max(0, capacity - loadOffset - aboardScu)
        : Number.POSITIVE_INFINITY
      batch = [...must, ...packTrip(current, open, room)]
      if (!batch.length) break
    } else {
      const room =
        seed && Number.isFinite(capacity)
          ? Math.max(0, capacity - loadOffset)
          : capacity
      batch = packTrip(current, remaining, room)
      if (!batch.length) {
        // Force-include smallest remaining job even if over size (should be rare)
        const smallest = remaining.sort((a, b) => a.scu - b.scu)[0]
        if (!smallest || seed) break
        batch.push(smallest)
      }
    }

    const tourCap = seed
      ? capacity
      : Math.max(
          capacity,
          batch.reduce((s, j) => s + j.scu, 0),
        )
    const tour = solveSingleTour(
      batch,
      current,
      tourCap,
      seed ? { loadOffset, preloadedIds } : undefined,
    )
    if (!tour) return null

    for (const s of tour.stops) allStops.push({ ...s, trip })
    peak = Math.max(peak, tour.peakLoad)
    for (const j of batch) pending.delete(j.id)
    current = tour.stops[tour.stops.length - 1]?.locationId ?? current
    trip += 1
    preloadedIds = new Set()
  }

  if (pending.size) return null
  return {
    stops: allStops,
    totalDistance: allStops.reduce((s, x) => s + x.legDistance, 0),
    tripCount: Math.max(1, trip),
    method: 'multitrip',
    peakLoad: peak,
  }
}

function packTrip(fromId: string, jobs: CargoJob[], capacity: number): CargoJob[] {
  const from = getLocation(fromId)
  const ranked = [...jobs].sort((a, b) => {
    const da =
      from && getLocation(a.pickupId) ? distanceBetween(from, getLocation(a.pickupId)!) : 0
    const db =
      from && getLocation(b.pickupId) ? distanceBetween(from, getLocation(b.pickupId)!) : 0
    return da - db
  })

  const batch: CargoJob[] = []
  let used = 0
  for (const j of ranked) {
    if (used + j.scu <= capacity) {
      batch.push(j)
      used += j.scu
    }
  }
  if (!batch.length) {
    const fit = ranked.filter((j) => j.scu <= capacity).sort((a, b) => b.scu - a.scu)
    if (fit[0]) batch.push(fit[0])
  }
  return batch
}

/**
 * Build TSP nodes with a dedicated depot at index 0.
 * Cargo pickup/dropoff locations are always additional nodes (even if they share
 * the depot's physical location) so the route can return to drop cargo.
 */
function buildTourGraph(
  jobs: CargoJob[],
  startId: string,
  preloadedIds?: ReadonlySet<string>,
): { nodes: string[]; mapped: JobMap[]; start: number } {
  const preloaded = preloadedIds ?? new Set<string>()
  const uses = new Map<string, { pick: boolean; drop: boolean }>()
  const touch = (id: string, role: 'pick' | 'drop') => {
    const cur = uses.get(id) ?? { pick: false, drop: false }
    cur[role] = true
    uses.set(id, cur)
  }
  for (const j of jobs) {
    if (!preloaded.has(j.id)) touch(j.pickupId, 'pick')
    touch(j.dropoffId, 'drop')
  }

  // A station that both loads and unloads needs two visits. One node cannot
  // be picked up from before it is delivered to, and delivered to before it
  // is picked up from.
  const cargoLocs: string[] = []
  const pickupIndex = new Map<string, number>()
  const dropIndex = new Map<string, number>()
  for (const [id, role] of uses) {
    if (role.pick) {
      cargoLocs.push(id)
      pickupIndex.set(id, cargoLocs.length)
    }
    if (role.drop) {
      cargoLocs.push(id)
      dropIndex.set(id, cargoLocs.length)
    }
  }

  // nodes[0] = depot (start). nodes[1..] = cargo stops (may repeat a location).
  const nodes = [startId, ...cargoLocs]
  const mapped: JobMap[] = jobs.map((j) => ({
    ...j,
    pickup: preloaded.has(j.id) ? 0 : pickupIndex.get(j.pickupId)!,
    dest: dropIndex.get(j.dropoffId)!,
    preloaded: preloaded.has(j.id),
  }))
  return { nodes, mapped, start: 0 }
}

function buildDistMatrix(nodes: string[]): number[][] {
  const n = nodes.length
  const dist = Array.from({ length: n }, () => Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const a = getLocation(nodes[i])
      const b = getLocation(nodes[j])
      dist[i][j] = a && b ? distanceBetween(a, b) : 1e9
    }
  }
  return dist
}

/**
 * A station that is the only dropoff of one objective and the only pickup of
 * another. Deliver and collect there on the same visit instead of returning.
 */
function hubLocationIds(jobs: CargoJob[]): Set<string> {
  const groups = new Map<string, CargoJob[]>()
  for (const j of jobs) {
    const key = j.id.slice(0, j.id.lastIndexOf(':'))
    const list = groups.get(key) ?? []
    list.push(j)
    groups.set(key, list)
  }
  const soleDrops = new Set<string>()
  const solePicks = new Set<string>()
  for (const list of groups.values()) {
    const drops = new Set(list.map((j) => j.dropoffId))
    const picks = new Set(list.map((j) => j.pickupId))
    if (drops.size === 1) soleDrops.add([...drops][0])
    if (picks.size === 1) solePicks.add([...picks][0])
  }
  const hubs = new Set<string>()
  for (const id of soleDrops) if (solePicks.has(id)) hubs.add(id)
  return hubs
}

/** Flight cost. Coming back to a hub after leaving it is almost never worth it. */
function stepCost(
  last: number,
  v: number,
  mask: number,
  dist: number[][],
  nodes: string[],
  hubs: ReadonlySet<string>,
): number {
  let cost = dist[last][v]
  const id = nodes[v]
  if (!id || nodes[last] === id || !hubs.has(id)) return cost
  for (let i = 0; i < nodes.length; i++) {
    if (i !== v && nodes[i] === id && (mask & (1 << i)) !== 0) {
      cost += HUB_REVISIT_PENALTY
      break
    }
  }
  return cost
}

type JobMap = CargoJob & { pickup: number; dest: number; preloaded?: boolean }

function loadForMask(mask: number, jobs: JobMap[], loadOffset = 0): number {
  let load = loadOffset
  for (const j of jobs) {
    const got = j.preloaded || ((mask >> j.pickup) & 1)
    const gone = (mask >> j.dest) & 1
    if (got && !gone) load += j.scu
  }
  return load
}

function canVisit(mask: number, v: number, jobs: JobMap[]): boolean {
  if ((mask >> v) & 1) return false
  for (const j of jobs) {
    if (j.dest === v && !j.preloaded && !((mask >> j.pickup) & 1)) return false
  }
  return true
}

function popcount(m: number): number {
  let c = 0
  while (m) {
    m &= m - 1
    c++
  }
  return c
}

function solveExact(input: {
  n: number
  dist: number[][]
  capacity: number
  start: number
  jobs: JobMap[]
  loadOffset?: number
  nodes: string[]
  hubs: ReadonlySet<string>
}): number[] | null | 'too-big' {
  const { n, dist, capacity, start, jobs, nodes, hubs } = input
  const loadOffset = input.loadOffset ?? 0
  if (n > EXACT_NODE_MAX) return 'too-big'
  const full = (1 << n) - 1
  const cap = capacity > 0 ? capacity : Infinity

  const dp = new Map<number, { cost: Float64Array; par: Int32Array }>()
  const ensure = (mask: number) => {
    let e = dp.get(mask)
    if (!e) {
      e = { cost: new Float64Array(n).fill(Infinity), par: new Int32Array(n).fill(-1) }
      dp.set(mask, e)
    }
    return e
  }
  const byLevel: number[][] = Array.from({ length: n + 1 }, () => [])
  const seen = new Set<number>()
  const push = (mask: number) => {
    if (seen.has(mask)) return
    seen.add(mask)
    byLevel[popcount(mask)].push(mask)
  }

  const m0 = 1 << start
  if (canVisit(0, start, jobs) && loadForMask(m0, jobs, loadOffset) <= cap) {
    ensure(m0).cost[start] = 0
    push(m0)
  }

  let work = 0
  for (let k = 1; k < n; k++) {
    for (const mask of byLevel[k]) {
      const e = dp.get(mask)!
      for (let last = 0; last < n; last++) {
        const base = e.cost[last]
        if (!Number.isFinite(base)) continue
        for (let v = 0; v < n; v++) {
          if (mask & (1 << v)) continue
          if (!canVisit(mask, v, jobs)) continue
          const nmask = mask | (1 << v)
          if (loadForMask(nmask, jobs, loadOffset) > cap) continue
          if (++work > EXACT_WORK_BUDGET) return 'too-big'
          const ne = ensure(nmask)
          const cost = base + stepCost(last, v, mask, dist, nodes, hubs)
          if (cost < ne.cost[v]) {
            ne.cost[v] = cost
            ne.par[v] = last
            push(nmask)
          }
        }
      }
    }
  }

  const fe = dp.get(full)
  if (!fe) return null
  let best = Infinity
  let bestLast = -1
  for (let v = 0; v < n; v++) {
    if (fe.cost[v] < best) {
      best = fe.cost[v]
      bestLast = v
    }
  }
  if (bestLast < 0) return null

  const order: number[] = []
  let mask = full
  let last = bestLast
  while (last !== -1) {
    order.push(last)
    const prev = dp.get(mask)!.par[last]
    mask &= ~(1 << last)
    last = prev
  }
  order.reverse()
  return order
}

function solveHeuristic(input: {
  n: number
  dist: number[][]
  capacity: number
  start: number
  jobs: JobMap[]
  loadOffset?: number
  nodes: string[]
  hubs: ReadonlySet<string>
}): number[] | null {
  const loadOffset = input.loadOffset ?? 0
  const seed = greedyFrom(
    input.start,
    input.n,
    input.dist,
    input.capacity,
    input.jobs,
    input.nodes,
    input.hubs,
    loadOffset,
  )
  if (!seed) return null
  return localSearch(
    seed,
    input.dist,
    input.capacity,
    input.start,
    input.jobs,
    input.nodes,
    input.hubs,
    loadOffset,
  )
}

function greedyFrom(
  start: number,
  n: number,
  dist: number[][],
  cap: number,
  jobs: JobMap[],
  nodes: string[],
  hubs: ReadonlySet<string>,
  loadOffset = 0,
): number[] | null {
  const order = [start]
  let mask = 1 << start
  while (order.length < n) {
    let next = -1
    let bestD = Infinity
    const last = order[order.length - 1]
    for (let v = 0; v < n; v++) {
      if (mask & (1 << v)) continue
      if (!canVisit(mask, v, jobs)) continue
      if (loadForMask(mask | (1 << v), jobs, loadOffset) > cap) continue
      const d = stepCost(last, v, mask, dist, nodes, hubs)
      if (d < bestD) {
        bestD = d
        next = v
      }
    }
    if (next < 0) return null
    order.push(next)
    mask |= 1 << next
  }
  return order
}

function orderFeasible(
  order: number[],
  jobs: JobMap[],
  cap: number,
  loadOffset = 0,
): boolean {
  let mask = 0
  for (const v of order) {
    if (!canVisit(mask, v, jobs)) return false
    mask |= 1 << v
    if (loadForMask(mask, jobs, loadOffset) > cap) return false
  }
  return true
}

function orderCost(
  order: number[],
  dist: number[][],
  nodes: string[],
  hubs: ReadonlySet<string>,
): number {
  let t = 0
  let mask = 0
  for (let i = 0; i < order.length; i++) {
    const v = order[i]
    if (i > 0) t += stepCost(order[i - 1], v, mask, dist, nodes, hubs)
    mask |= 1 << v
  }
  return t
}

function localSearch(
  seed: number[],
  dist: number[][],
  cap: number,
  start: number,
  jobs: JobMap[],
  nodes: string[],
  hubs: ReadonlySet<string>,
  loadOffset = 0,
): number[] {
  let best = seed.slice()
  let bestD = orderCost(best, dist, nodes, hubs)
  let improved = true
  while (improved) {
    improved = false
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1))
        if (cand[0] !== start) continue
        if (!orderFeasible(cand, jobs, cap, loadOffset)) continue
        const d = orderCost(cand, dist, nodes, hubs)
        if (d < bestD - 1e-9) {
          best = cand
          bestD = d
          improved = true
        }
      }
    }
  }
  return best
}

function materialize(
  order: number[],
  nodes: string[],
  jobs: JobMap[],
  trip: number,
  initialLoad = 0,
): { stops: RouteStop[]; totalDistance: number; peakLoad: number } {
  const stops: RouteStop[] = []
  const aboard = new Set(jobs.filter((j) => j.preloaded).map((j) => j.id))
  let load = initialLoad
  let peak = initialLoad
  let prevLoc = nodes[order[0]]

  function pushActions(
    locId: string,
    drops: JobMap[],
    picks: JobMap[],
    leg: number,
  ) {
    let first = true

    // One dropoff line per mission (jobs were split per pickup share)
    const dropGroups = groupJobsByMission(drops)
    for (const group of dropGroups) {
      const scu = group.reduce((s, j) => s + j.scu, 0)
      for (const j of group) aboard.delete(j.id)
      load -= scu
      const head = group[0]
      stops.push({
        missionId: head.missionId,
        missionName: head.missionName,
        kind: 'dropoff',
        locationId: locId,
        locationName: getLocation(locId)?.name ?? locId,
        cargoDelta: -scu,
        cargoAfter: load,
        legDistance: first ? leg : 0,
        trip,
        stopRemaining: 0,
        commodity: head.commodity,
      })
      first = false
    }

    // One pickup line per mission+commodity at this location
    const pickGroups = groupJobsByMission(picks)
    for (const group of pickGroups) {
      const scu = group.reduce((s, j) => s + j.scu, 0)
      for (const j of group) aboard.add(j.id)
      load += scu
      const head = group[0]
      stops.push({
        missionId: head.missionId,
        missionName: head.missionName,
        kind: 'pickup',
        locationId: locId,
        locationName: getLocation(locId)?.name ?? locId,
        cargoDelta: scu,
        cargoAfter: load,
        legDistance: first ? leg : 0,
        trip,
        stopRemaining: 0,
        commodity: head.commodity,
      })
      first = false
    }
    if (load > peak) peak = load
  }

  for (let k = 0; k < order.length; k++) {
    const nodeIdx = order[k]
    const locId = nodes[nodeIdx]
    const drops = jobs.filter((j) => j.dest === nodeIdx && aboard.has(j.id))
    const picks = jobs.filter((j) => j.pickup === nodeIdx && !aboard.has(j.id))
    // Depot (node 0) has no cargo actions — skip unless something somehow maps here
    if (!drops.length && !picks.length) {
      if (locId !== prevLoc) prevLoc = locId
      continue
    }

    let leg = 0
    if (locId !== prevLoc) {
      const a = getLocation(prevLoc)
      const b = getLocation(locId)
      leg = a && b ? distanceBetween(a, b) : 0
      prevLoc = locId
    }

    pushActions(locId, drops, picks, leg)
  }

  // Safety: any cargo still aboard must be dropped (e.g. missed dest visit)
  const leftover = jobs.filter((j) => aboard.has(j.id))
  if (leftover.length) {
    const byDest = new Map<number, JobMap[]>()
    for (const j of leftover) {
      const list = byDest.get(j.dest) ?? []
      list.push(j)
      byDest.set(j.dest, list)
    }
    for (const [destIdx, group] of byDest) {
      const locId = nodes[destIdx]
      let leg = 0
      if (locId !== prevLoc) {
        const a = getLocation(prevLoc)
        const b = getLocation(locId)
        leg = a && b ? distanceBetween(a, b) : 0
        prevLoc = locId
      }
      pushActions(locId, group, [], leg)
    }
  }

  return {
    stops,
    totalDistance: stops.reduce((s, x) => s + x.legDistance, 0),
    peakLoad: peak,
  }
}

function groupJobsByMission(jobs: JobMap[]): JobMap[][] {
  const map = new Map<string, JobMap[]>()
  for (const j of jobs) {
    const key = `${j.missionId}|${j.commodity ?? ''}`
    const list = map.get(key) ?? []
    list.push(j)
    map.set(key, list)
  }
  return [...map.values()]
}

interface JobLedger {
  job: CargoJob
  picked: number
  dropped: number
}

function commodityMatches(job: CargoJob, action: RouteStop): boolean {
  if (!action.commodity || !job.commodity) return true
  return action.commodity === job.commodity
}

/** Apply done-stop actions onto jobs so the rest plan keeps aboard cargo. */
function consumeDoneStops(
  jobs: CargoJob[],
  prefix: RouteStop[],
  trustCargoAfter = true,
): { open: CargoJob[]; aboard: CargoJob[]; holdScu: number } {
  const ledger: JobLedger[] = jobs.map((job) => ({ job, picked: 0, dropped: 0 }))
  let matchedHold = 0
  for (const action of prefix) {
    let left = Math.abs(action.cargoDelta)
    if (left <= 0) continue
    const rows = ledger.filter((row) => {
      if (row.job.missionId !== action.missionId) return false
      if (!commodityMatches(row.job, action)) return false
      if (action.kind === 'pickup') {
        return row.job.pickupId === action.locationId && row.picked < row.job.scu
      }
      return row.job.dropoffId === action.locationId && row.dropped < row.job.scu
    })
    if (action.kind === 'dropoff') {
      rows.sort((a, b) => b.picked - b.dropped - (a.picked - a.dropped))
    }
    for (const row of rows) {
      if (left <= 0) break
      if (action.kind === 'pickup') {
        const n = Math.min(left, row.job.scu - row.picked)
        row.picked += n
        matchedHold += n
        left -= n
      } else {
        const n = Math.min(left, row.job.scu - row.dropped)
        const already = row.picked - row.dropped
        if (already < n) {
          const extra = n - already
          row.picked += extra
          matchedHold += extra
        }
        row.dropped += n
        matchedHold -= n
        left -= n
      }
    }
  }

  const open: CargoJob[] = []
  const aboard: CargoJob[] = []
  for (const row of ledger) {
    const aboardScu = row.picked - row.dropped
    const unpicked = row.job.scu - row.picked
    if (aboardScu > 0) {
      aboard.push({ ...row.job, id: `${row.job.id}#aboard`, scu: aboardScu })
    }
    if (unpicked > 0) {
      open.push({ ...row.job, id: `${row.job.id}#open`, scu: unpicked })
    }
  }
  const actionHold = prefix.length
    ? Math.max(0, prefix[prefix.length - 1].cargoAfter)
    : 0
  const holdScu = trustCargoAfter ? actionHold : Math.max(0, matchedHold)
  return { open, aboard, holdScu }
}

/**
 * Keep done stops as-is and re-optimize only unfinished cargo.
 * Aboard loads from those stops stay on the ship and must still be delivered.
 */
export function optimizeRouteFollowing(
  missions: Mission[],
  capacityScu: number,
  prefixStops: RouteStop[],
  fromLocationId: string,
  options?: { trustCargoAfter?: boolean },
): OptimizedRoute | null {
  if (!prefixStops.length || !getLocation(fromLocationId)) return null
  const ready = repairMissionLocations(missions)
  const reportedCapacity = Math.max(0, capacityScu)
  const hold = resolveHoldCapacity(reportedCapacity)
  const workable = ready.filter((m) => isFeasible(m, hold))
  const jobs = expandJobs(workable.length ? workable : ready)
  if (!jobs.length) return null

  const { open, aboard, holdScu } = consumeDoneStops(
    jobs,
    prefixStops,
    options?.trustCargoAfter !== false,
  )
  const remaining = [...aboard, ...open]
  if (!remaining.length) return null

  const aboardScu = aboard.reduce((s, j) => s + j.scu, 0)
  const loadOffset = Math.max(0, holdScu - aboardScu)
  const preloadedIds = new Set(aboard.map((j) => j.id))
  const planned = planJobs(remaining, fromLocationId, hold, {
    loadOffset,
    preloadedIds,
  })
  if (!planned) return null

  const tripBase = (prefixStops[prefixStops.length - 1]?.trip ?? -1) + 1
  const suffix = planned.stops.map((s) => ({ ...s, trip: tripBase + s.trip }))
  const stops = [...prefixStops, ...suffix]
  const prefixPeak = prefixStops.reduce((m, s) => Math.max(m, s.cargoAfter), 0)
  const reward = ready.reduce((s, m) => {
    const total = missionCargoTotal(m)
    return s + (m.rewardAuec ?? total * 1000)
  }, 0)
  const cargo = ready.reduce((s, m) => s + missionCargoTotal(m), 0)

  return {
    selectedMissionIds: ready.map((m) => m.id),
    skippedMissionIds: [],
    stops,
    totalDistance: stops.reduce((s, x) => s + x.legDistance, 0),
    totalReward: reward,
    totalCargoScu: cargo,
    capacityScu: reportedCapacity,
    tripCount: planned.tripCount,
    method: 'following',
    peakLoad: Math.max(prefixPeak, planned.peakLoad),
  }
}

function cargoKey(stop: RouteStop): string {
  return `${stop.missionId}|${stop.commodity ?? ''}`
}

/** Running pickup pool after these actions. Null when a drop happens too early. */
function poolAfter(stops: RouteStop[]): Map<string, number> | null {
  const pool = new Map<string, number>()
  for (const s of stops) {
    const key = cargoKey(s)
    const scu = Math.abs(s.cargoDelta)
    if (s.kind === 'dropoff') {
      const have = pool.get(key) ?? 0
      if (have < scu) return null
      pool.set(key, have - scu)
    } else {
      pool.set(key, (pool.get(key) ?? 0) + scu)
    }
  }
  return pool
}

function resequenceSuffix(
  stops: RouteStop[],
  prevLocationId: string,
  load: number,
  capacityScu: number,
  pool: Map<string, number>,
  options?: { ignoreCapacity?: boolean },
): RouteStop[] | null {
  const out: RouteStop[] = []
  let prev = prevLocationId
  for (const s of stops) {
    const key = cargoKey(s)
    const scu = Math.abs(s.cargoDelta)
    if (s.kind === 'dropoff') {
      const have = pool.get(key) ?? 0
      if (have < scu) return null
      pool.set(key, have - scu)
    }
    let leg = 0
    if (s.locationId !== prev) {
      const a = getLocation(prev)
      const b = getLocation(s.locationId)
      leg = a && b ? distanceBetween(a, b) : 0
      prev = s.locationId
    }
    load += s.cargoDelta
    if (load < -1e-6) return null
    if (!options?.ignoreCapacity && capacityScu > 0 && load > capacityScu + 1e-6) return null
    if (s.kind === 'pickup') pool.set(key, (pool.get(key) ?? 0) + scu)
    out.push({ ...s, legDistance: leg, cargoAfter: load })
  }
  return out
}

/** Replay stop actions from a start so hold and legs match only those stops. */
export function resequenceRouteStops(
  stops: RouteStop[],
  startLocationId: string,
  capacityScu: number,
  options?: { ignoreCapacity?: boolean },
): RouteStop[] | null {
  return resequenceSuffix(stops, startLocationId, 0, capacityScu, new Map(), options)
}

/** Move one unfinished location visit. Done prefix stops are left unchanged. */
export function moveRouteGroup(
  route: OptimizedRoute,
  startLocationId: string,
  doneGroupCount: number,
  groupIndex: number,
  delta: -1 | 1,
): OptimizedRoute | null {
  const groups = groupRouteByLocation(route.stops)
  const nextIndex = groupIndex + delta
  if (groupIndex < doneGroupCount || nextIndex < doneGroupCount) return null
  if (nextIndex < 0 || nextIndex >= groups.length) return null

  const nextGroups = groups.slice()
  const [moved] = nextGroups.splice(groupIndex, 1)
  nextGroups.splice(nextIndex, 0, moved)

  const prefixStops = nextGroups.slice(0, doneGroupCount).flatMap((g) => g.actions)
  const restStops = nextGroups.slice(doneGroupCount).flatMap((g) => g.actions)
  const pool = poolAfter(prefixStops)
  if (!pool) return null
  const prevLocationId = prefixStops.length
    ? prefixStops[prefixStops.length - 1].locationId
    : startLocationId
  const load = prefixStops.length
    ? prefixStops[prefixStops.length - 1].cargoAfter
    : 0
  const suffix = resequenceSuffix(
    restStops,
    prevLocationId,
    load,
    route.capacityScu,
    pool,
  )
  if (!suffix) return null

  const stops = [...prefixStops, ...suffix]
  const peakLoad = stops.reduce((m, s) => Math.max(m, s.cargoAfter), 0)
  return {
    ...route,
    stops,
    totalDistance: stops.reduce((s, x) => s + x.legDistance, 0),
    peakLoad,
  }
}

export function formatDistance(gm: number): string {
  if (gm >= 100) return `${gm.toFixed(0)} Gm`
  if (gm >= 1) return `${gm.toFixed(2)} Gm`
  if (gm >= 0.001) return `${(gm * 1000).toFixed(0)} Mm`
  return `${(gm * 1e6).toFixed(0)} km`
}

export function formatAuec(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n)) + ' aUEC'
}
