/**
 * Download latest SCMDB merged dump and write a compact haul-demo catalog.
 * Usage: node scripts/fetch-scmdb-hauls.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCMDB = 'https://scmdb.net'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/data/scmdbHauls.json')

const SKIP_TYPES = new Set(['Star', 'Planet', 'Moon', 'Default'])

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json()
}

function isStop(pool) {
  if (!pool?.name || String(pool.name).startsWith('@')) return false
  if (SKIP_TYPES.has(pool.type)) return false
  if (/^Outpost /i.test(pool.name)) return false
  return true
}

function resolveStops(ids, pools) {
  const names = []
  const seen = new Set()
  for (const id of ids ?? []) {
    const p = pools[id]
    if (!isStop(p)) continue
    const n = p.name.trim()
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(n)
  }
  return names
}

function inferMulti(debugName = '', title = '') {
  const s = `${debugName} ${title}`
  if (/SingleToMulti/i.test(s)) return 'dropoff'
  if (/Multi\d*ToSingle|MultiToSingle/i.test(s)) return 'pickup'
  if (/AToB|_Single_/i.test(s)) return 'single'
  return 'single'
}

function inferHaulHint(c) {
  const tokens = c.tokenSubstitutions || {}
  const blob = [
    c.title,
    c.debugName,
    tokens.CargoRouteToken,
    tokens.CargoGradeToken,
    tokens.MultiToSingleToken,
  ]
    .filter(Boolean)
    .join(' ')
  const m = blob.match(/\b(Local|Planetary|Stellar|Interstellar)\b/i)
  const size = blob.match(/\b(Small|Medium|Large)\b/i)
  if (m) {
    const scope = m[1].replace(/^./, (c) => c.toUpperCase())
    const sz = (size?.[1] ?? 'Medium').replace(/^./, (c) => c.toUpperCase())
    return `${scope} ${sz} Haul`
  }
  return undefined
}

function collectPools(c, pools) {
  const pick = new Set()
  const drop = new Set()
  for (const n of resolveStops(c.locations, pools)) pick.add(n)
  for (const n of resolveStops(c.destinations, pools)) drop.add(n)
  for (const set of c.locationSets ?? []) {
    for (const n of resolveStops(set.locations, pools)) pick.add(n)
    for (const n of resolveStops(set.destinations, pools)) drop.add(n)
  }
  // Red Wind / similar: only destinations listed as concrete stations
  if (!pick.size && drop.size >= 2) {
    const all = [...drop]
    // Prefer a named station from the debug/title as the single side
    const named =
      all.find((n) => new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(c.debugName || '')) ||
      all.find((n) => /Ruin/i.test(n)) ||
      all[0]
    pick.add(named)
    drop.delete(named)
  }
  return { pickupPool: [...pick], dropoffPool: [...drop] }
}

function resourceName(resources, id) {
  const r = resources[id]
  const n = r?.name
  if (!n || /PLACEHOLDER/i.test(n)) return null
  return n
}

function collectActiveGivers(data) {
  const names = new Set()
  for (const c of data.contracts ?? []) {
    if (!c.haulingOrders?.length) continue
    const n = typeof c.contractorName === 'string' ? c.contractorName.trim() : ''
    if (n) names.add(n)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

function buildTemplates(data) {
  const pools = data.locationPools || {}
  const resources = data.resourcePools || {}
  const out = []

  for (const c of data.contracts ?? []) {
    if (!c.haulingOrders?.length) continue
    const { pickupPool, dropoffPool } = collectPools(c, pools)
    if (!pickupPool.length || !dropoffPool.length) continue

    const orders = []
    for (const o of c.haulingOrders) {
      const commodity = resourceName(resources, o.resource)
      if (!commodity) continue
      const minSCU = Number(o.minSCU ?? o.minAmount ?? 0) || 0
      const maxSCU = Number(o.maxSCU ?? o.maxAmount ?? 0) || 0
      const maxUnit = Number(o.maxContainerSize ?? 0) || 0
      if (!minSCU && !maxSCU) continue
      orders.push({ commodity, minSCU, maxSCU, maxUnit })
    }
    if (!orders.length) continue

    // Deduplicate commodity lines (SCMDB often repeats per drop)
    const byCommodity = new Map()
    for (const o of orders) {
      const prev = byCommodity.get(o.commodity)
      if (!prev) byCommodity.set(o.commodity, { ...o })
      else {
        prev.minSCU = Math.max(prev.minSCU, o.minSCU)
        prev.maxSCU = Math.max(prev.maxSCU, o.maxSCU)
        prev.maxUnit = Math.max(prev.maxUnit, o.maxUnit)
      }
    }
    const uniq = [...byCommodity.values()]
    const minScu = uniq.reduce((s, o) => s + o.minSCU, 0)
    const maxScu = uniq.reduce((s, o) => s + (o.maxSCU || o.minSCU), 0)
    const maxUnitScu = Math.max(...uniq.map((o) => o.maxUnit || 1), 1)
    const commodity =
      uniq.length === 1 ? uniq[0].commodity : uniq.map((o) => o.commodity).join(' / ')

    let title = String(c.title || c.debugName || 'Haul')
    title = title
      .replace(/\[DESTINATION\]/gi, dropoffPool[0])
      .replace(/\[LOCATION\]/gi, pickupPool[0])
      .replace(/\[TARGET\]/gi, pickupPool[0])

    out.push({
      id: c.id || c.debugName,
      debugName: c.debugName || '',
      title,
      giver: c.contractorName || undefined,
      rewardAuec: Number(c.rewardUEC) || 0,
      commodity,
      minScu: Math.max(1, minScu),
      maxScu: Math.max(1, maxScu || minScu),
      maxUnitScu,
      pickupPool,
      dropoffPool,
      multi: inferMulti(c.debugName, title),
      haulHint: inferHaulHint(c),
      illegal: Boolean(c.illegal),
    })
  }

  // Prefer real cargo contracts; keep harvestables only if needed for volume
  const cargo = out.filter((t) => /HaulCargo|CargoHauling|Cargo Haul|RedWind|Ling|Transport/i.test(t.debugName + t.title))
  const rest = out.filter((t) => !cargo.includes(t))
  const merged = [...cargo, ...rest]
  // Deduplicate by debugName
  const seen = new Set()
  return merged.filter((t) => {
    const key = t.debugName || t.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const versions = await fetchJson(`${SCMDB}/data/versions.json`)
const latest = versions?.[0]
if (!latest?.file) throw new Error('No SCMDB version listed')
console.log('Fetching', latest.version, latest.file)
const data = await fetchJson(`${SCMDB}/data/${latest.file}`)
const hauls = buildTemplates(data)
const givers = collectActiveGivers(data)
mkdirSync(dirname(OUT), { recursive: true })
const payload = {
  version: data.version || latest.version,
  generatedAt: new Date().toISOString(),
  count: hauls.length,
  givers,
  hauls,
}
writeFileSync(OUT, JSON.stringify(payload))
console.log(`Wrote ${hauls.length} hauls, ${givers.length} givers → ${OUT}`)
