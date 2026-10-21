/**
 * Capacitated pickup-and-delivery planner.
 * Always routes every mission / location — never skips stops.
 * Splits into trips only when total cargo exceeds hold capacity.
 */

import { legacyMissionToObjectives, missionTotalScu } from './objectives'
import { distanceBetween, getLocation } from '../store/catalog'
import type { Mission, MissionObjective, OptimizedRoute, RouteStop } from '../types'

interface CargoJob {
  id: string
  missionId: string
  missionName: string
  pickupId: string
  dropoffId: string
  scu: number
  commodity?: string
}

const EXACT_NODE_MAX = 14
const EXACT_WORK_BUDGET = 1_500_000

export function optimizeRoute(
  missions: Mission[],
  startLocationId: string,
  capacityScu: number,
): OptimizedRoute {
  if (!getLocation(startLocationId)) return emptyRoute(capacityScu, missions)

  const workable = missions.filter((m) => isFeasible(m, capacityScu))
  // Still attempt every mission; infeasible ones are kept but may force multi-trip / partial
  const jobs = expandJobs(workable.length ? workable : missions)
  if (!jobs.length) return emptyRoute(capacityScu, missions)

  const planned = planJobs(jobs, startLocationId, capacityScu)
  if (!planned) return emptyRoute(capacityScu, missions)

  const reward = missions.reduce((s, m) => {
    const total = missionCargoTotal(m)
    return s + (m.rewardAuec ?? total * 1000)
  }, 0)
  const cargo = missions.reduce((s, m) => s + missionCargoTotal(m), 0)

  return {
    selectedMissionIds: missions.map((m) => m.id),
    skippedMissionIds: [],
    stops: planned.stops,
    totalDistance: planned.totalDistance,
    totalReward: reward,
    totalCargoScu: cargo,
    capacityScu,
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
  if (capacity < 1 || missionCargoTotal(m) <= 0) return false
  const objectives = legacyMissionToObjectives(m)
  if (!objectives.some((o) => o.pickups.length && o.dropoffs.length)) return false
  return objectives.every(
    (o) =>
      o.pickups.every((p) => getLocation(p.locationId)) &&
      o.dropoffs.every((d) => getLocation(d.locationId)),
  )
}

function expandObjectiveJobs(
  m: Mission,
  obj: MissionObjective,
  objIndex: number,
): CargoJob[] {
  const jobs: CargoJob[] = []
  const commodity = obj.commodity.trim() || m.commodity
  const prefix = `${m.id}:o${objIndex}`

  if (obj.pickups.length > 1 && obj.dropoffs.length > 1) {
    const dropTotal = obj.dropoffs.reduce((s, d) => s + Math.max(0, d.scu), 0)
    for (const p of obj.pickups) {
      if (p.scu <= 0) continue
      if (dropTotal <= 0) {
        const dest = obj.dropoffs[0]
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
      obj.dropoffs.forEach((d, di) => {
        const isLast = di === obj.dropoffs.length - 1
        const share = isLast
          ? p.scu - assigned
          : Math.round((p.scu * Math.max(0, d.scu)) / dropTotal)
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
  } else if (obj.pickups.length >= 1 && obj.dropoffs.length === 1) {
    const dest = obj.dropoffs[0].locationId
    for (const p of obj.pickups) {
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
  } else if (obj.pickups.length === 1 && obj.dropoffs.length >= 1) {
    const src = obj.pickups[0].locationId
    for (const d of obj.dropoffs) {
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
): {
  stops: RouteStop[]
  totalDistance: number
  tripCount: number
  method: OptimizedRoute['method']
  peakLoad: number
} | null {
  const total = jobs.reduce((s, j) => s + j.scu, 0)
  if (total <= capacity) {
    const single = solveSingleTour(jobs, startId, capacity)
    if (!single) return null
    return { ...single, tripCount: 1 }
  }
  return solveMultiTrip(jobs, startId, capacity)
}

function solveSingleTour(
  jobs: CargoJob[],
  startId: string,
  capacity: number,
): {
  stops: RouteStop[]
  totalDistance: number
  method: 'exact' | 'heuristic'
  peakLoad: number
} | null {
  // Depot is always node 0 (even when start == a pickup/dropoff). Cargo stops are
  // separate nodes so we can leave and return to unload at the starting location.
  const { nodes, mapped, start } = buildTourGraph(jobs, startId)
  const dist = buildDistMatrix(nodes)
  const n = nodes.length
  const input = { n, dist, capacity, start, jobs: mapped }

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

  const material = materialize(order, nodes, mapped, 0)
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

  while (pending.size && guard++ < 200) {
    const remaining = [...pending].map((id) => byId.get(id)!)
    const batch = packTrip(current, remaining, capacity)
    if (!batch.length) {
      // Force-include smallest remaining job even if over size (should be rare)
      const smallest = remaining.sort((a, b) => a.scu - b.scu)[0]
      if (!smallest) break
      batch.push(smallest)
    }

    const tour = solveSingleTour(batch, current, Math.max(capacity, batch.reduce((s, j) => s + j.scu, 0)))
    if (!tour) return null

    for (const s of tour.stops) allStops.push({ ...s, trip })
    peak = Math.max(peak, tour.peakLoad)
    for (const j of batch) pending.delete(j.id)
    current = tour.stops[tour.stops.length - 1]?.locationId ?? current
    trip += 1
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
): { nodes: string[]; mapped: JobMap[]; start: number } {
  const cargoLocs: string[] = []
  const seen = new Set<string>()
  for (const j of jobs) {
    for (const id of [j.pickupId, j.dropoffId]) {
      if (seen.has(id)) continue
      seen.add(id)
      cargoLocs.push(id)
    }
  }
  // nodes[0] = depot (start). nodes[1..] = cargo stops (may duplicate startId).
  const nodes = [startId, ...cargoLocs]
  const stopIndex = new Map(cargoLocs.map((id, i) => [id, i + 1]))
  const mapped: JobMap[] = jobs.map((j) => ({
    ...j,
    pickup: stopIndex.get(j.pickupId)!,
    dest: stopIndex.get(j.dropoffId)!,
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

type JobMap = CargoJob & { pickup: number; dest: number }

function loadForMask(mask: number, jobs: JobMap[]): number {
  let load = 0
  for (const j of jobs) {
    const got = (mask >> j.pickup) & 1
    const gone = (mask >> j.dest) & 1
    if (got && !gone) load += j.scu
  }
  return load
}

function canVisit(mask: number, v: number, jobs: JobMap[]): boolean {
  if ((mask >> v) & 1) return false
  for (const j of jobs) {
    if (j.dest === v && !((mask >> j.pickup) & 1)) return false
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
}): number[] | null | 'too-big' {
  const { n, dist, capacity, start, jobs } = input
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
  if (canVisit(0, start, jobs) && loadForMask(m0, jobs) <= cap) {
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
          if (loadForMask(nmask, jobs) > cap) continue
          if (++work > EXACT_WORK_BUDGET) return 'too-big'
          const ne = ensure(nmask)
          const cost = base + dist[last][v]
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
}): number[] | null {
  const seed = greedyFrom(input.start, input.n, input.dist, input.capacity, input.jobs)
  if (!seed) return null
  return localSearch(seed, input.dist, input.capacity, input.start, input.jobs)
}

function greedyFrom(
  start: number,
  n: number,
  dist: number[][],
  cap: number,
  jobs: JobMap[],
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
      if (loadForMask(mask | (1 << v), jobs) > cap) continue
      if (dist[last][v] < bestD) {
        bestD = dist[last][v]
        next = v
      }
    }
    if (next < 0) return null
    order.push(next)
    mask |= 1 << next
  }
  return order
}

function orderFeasible(order: number[], jobs: JobMap[], cap: number): boolean {
  let mask = 0
  for (const v of order) {
    if (!canVisit(mask, v, jobs)) return false
    mask |= 1 << v
    if (loadForMask(mask, jobs) > cap) return false
  }
  return true
}

function orderDistance(order: number[], dist: number[][]): number {
  let t = 0
  for (let i = 1; i < order.length; i++) t += dist[order[i - 1]][order[i]]
  return t
}

function localSearch(
  seed: number[],
  dist: number[][],
  cap: number,
  start: number,
  jobs: JobMap[],
): number[] {
  let best = seed.slice()
  let bestD = orderDistance(best, dist)
  let improved = true
  while (improved) {
    improved = false
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1))
        if (cand[0] !== start) continue
        if (!orderFeasible(cand, jobs, cap)) continue
        const d = orderDistance(cand, dist)
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
): { stops: RouteStop[]; totalDistance: number; peakLoad: number } {
  const stops: RouteStop[] = []
  const aboard = new Set<string>()
  let load = 0
  let peak = 0
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

export function formatDistance(gm: number): string {
  if (gm >= 100) return `${gm.toFixed(0)} Gm`
  if (gm >= 1) return `${gm.toFixed(2)} Gm`
  if (gm >= 0.001) return `${(gm * 1000).toFixed(0)} Mm`
  return `${(gm * 1e6).toFixed(0)} km`
}

export function formatAuec(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n)) + ' aUEC'
}
