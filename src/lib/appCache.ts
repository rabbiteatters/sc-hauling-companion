import {
  DEFAULT_HAUL_RANK,
  DEFAULT_HAUL_TYPE,
  HAUL_RANKS,
  HAUL_TYPES,
  parseHaulRank,
} from './haulTypes'
import {
  createEmptyObjective,
  legacyMissionToObjectives,
  missionTotalScu,
  newObjectiveId,
  withObjectiveAggregates,
  type DraftObjective,
} from './objectives'
import { clampMissionCode, DEFAULT_MAX_UNIT_SCU, normalizeCrateSize } from './spread'
import type { HaulType, Mission, MissionStop } from '../types'

const STORAGE_KEY = 'sc-hauling-app-cache-v1'

export type CapacityMode = 'ship' | 'custom'

export interface DraftCache {
  code: string
  name: string
  giver: string
  rank: string
  /** @deprecated prefer objectives — kept for migration / mirrors */
  pickupIds: string[]
  dropoffIds: string[]
  totalScu: number
  maxUnitScu: number
  rewardAuec: number
  commodity: string
  objectives: DraftObjective[]
  /** Sample haul — auto title keeps a (DEMO) prefix */
  demo?: boolean
}

export interface AppCache {
  capacityMode: CapacityMode
  shipId: string
  customScu: number
  startId: string
  draftHaul: HaulType
  draft: DraftCache
  missions: Mission[]
  /**
   * True after missions have been seeded or user-edited (incl. purge).
   * Prevents reloading demos over an intentionally empty list.
   */
  missionsInitialized: boolean
}

function defaultDraftObjective(): DraftObjective {
  return createEmptyObjective({
    commodity: 'Potassium',
    totalScu: 126,
    pickups: [],
    dropoffs: [],
  })
}

export const DEFAULT_DRAFT: DraftCache = {
  code: 'C01',
  name: '',
  giver: '',
  rank: DEFAULT_HAUL_RANK,
  pickupIds: [],
  dropoffIds: [],
  totalScu: 126,
  maxUnitScu: DEFAULT_MAX_UNIT_SCU,
  rewardAuec: 958250,
  commodity: 'Potassium',
  objectives: [defaultDraftObjective()],
  demo: false,
}

export const DEFAULT_APP_CACHE: AppCache = {
  capacityMode: 'ship',
  shipId: '',
  customScu: 196,
  startId: '',
  draftHaul: DEFAULT_HAUL_TYPE,
  draft: { ...DEFAULT_DRAFT, objectives: [defaultDraftObjective()] },
  missions: [],
  missionsInitialized: false,
}

function isHaulType(v: unknown): v is HaulType {
  return typeof v === 'string' && (HAUL_TYPES as string[]).includes(v)
}

function sanitizeStops(raw: unknown, withConfirmed: boolean): MissionStop[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((p) => p && typeof (p as MissionStop).locationId === 'string')
    .map((p) => {
      const s = p as MissionStop
      return {
        locationId: s.locationId,
        scu: Math.max(0, Number(s.scu) || 0),
        ...(withConfirmed ? { confirmed: Boolean(s.confirmed) } : {}),
      }
    })
}

function sanitizeDraftObjective(raw: unknown): DraftObjective | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<DraftObjective>
  return {
    id: typeof o.id === 'string' && o.id ? o.id : newObjectiveId(),
    commodity: typeof o.commodity === 'string' ? o.commodity : '',
    totalScu: Math.max(0, Number(o.totalScu) || 0),
    pickups: sanitizeStops(o.pickups, true),
    dropoffs: sanitizeStops(o.dropoffs, false),
  }
}

/** Mirror flat draft fields from objectives (first / aggregates). */
export function syncDraftFromObjectives(draft: DraftCache): DraftCache {
  const objectives =
    draft.objectives?.length > 0
      ? draft.objectives
      : [
          createEmptyObjective({
            commodity: draft.commodity,
            totalScu: draft.totalScu,
            pickups: draft.pickupIds.map((locationId) => ({
              locationId,
              scu: 0,
            })),
            dropoffs: draft.dropoffIds.map((locationId) => ({
              locationId,
              scu: 0,
            })),
          }),
        ]
  const first = objectives[0]
  const allPickups = [
    ...new Set(objectives.flatMap((o) => o.pickups.map((p) => p.locationId))),
  ]
  const allDropoffs = [
    ...new Set(objectives.flatMap((o) => o.dropoffs.map((d) => d.locationId))),
  ]
  const commodities = [
    ...new Set(objectives.map((o) => o.commodity.trim()).filter(Boolean)),
  ]
  return {
    ...draft,
    objectives,
    pickupIds: allPickups,
    dropoffIds: allDropoffs,
    totalScu: Math.max(1, missionTotalScu(objectives) || draft.totalScu || 1),
    commodity:
      commodities.length === 1
        ? commodities[0]
        : commodities.length > 1
          ? commodities.join(', ')
          : first?.commodity ?? draft.commodity,
  }
}

function sanitizeMission(raw: unknown): Mission | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Partial<Mission> & { objectives?: unknown }
  const hasFlat =
    Array.isArray(m.pickups) &&
    Array.isArray(m.dropoffs) &&
    m.pickups.length + m.dropoffs.length > 0
  const hasObjectives = Array.isArray(m.objectives) && m.objectives.length > 0
  if (!m.id || !m.name) return null
  if (!hasFlat && !hasObjectives) return null

  const haulType = isHaulType(m.haulType) ? m.haulType : DEFAULT_HAUL_TYPE
  const rankRaw = typeof m.rank === 'string' ? m.rank.trim() : ''
  const rank =
    rankRaw ||
    parseHaulRank(String(m.name)) ||
    undefined

  const pickups = sanitizeStops(m.pickups, true)
  const dropoffs = sanitizeStops(m.dropoffs, false)

  const objectives = legacyMissionToObjectives({
    commodity: typeof m.commodity === 'string' ? m.commodity : undefined,
    totalScu: Math.max(1, Number(m.totalScu) || 1),
    pickups,
    dropoffs,
    objectives: hasObjectives
      ? (m.objectives as Mission['objectives'])
      : undefined,
  })

  return withObjectiveAggregates({
    id: String(m.id),
    code:
      typeof m.code === 'string' && m.code.trim()
        ? clampMissionCode(m.code)
        : 'C01',
    name: String(m.name),
    haulType,
    rank: rank
      ? (HAUL_RANKS as string[]).includes(rank)
        ? (rank as (typeof HAUL_RANKS)[number])
        : rank
      : undefined,
    giver: typeof m.giver === 'string' ? m.giver : undefined,
    commodity: typeof m.commodity === 'string' ? m.commodity : undefined,
    rewardAuec: typeof m.rewardAuec === 'number' ? m.rewardAuec : undefined,
    totalScu: Math.max(1, Number(m.totalScu) || 1),
    maxUnitScu: normalizeCrateSize(Number(m.maxUnitScu) || DEFAULT_MAX_UNIT_SCU),
    pickups,
    dropoffs,
    objectives,
    source:
      m.source === 'ocr' || m.source === 'demo' || m.source === 'manual'
        ? m.source
        : 'manual',
  })
}

function sanitizeDraft(raw: unknown): DraftCache {
  const d = raw && typeof raw === 'object' ? (raw as Partial<DraftCache>) : {}
  const rank =
    typeof d.rank === 'string' && d.rank.trim()
      ? d.rank.trim()
      : parseHaulRank(typeof d.name === 'string' ? d.name : '') || DEFAULT_DRAFT.rank

  const pickupIds = Array.isArray(d.pickupIds)
    ? d.pickupIds.filter((x): x is string => typeof x === 'string')
    : []
  const dropoffIds = Array.isArray(d.dropoffIds)
    ? d.dropoffIds.filter((x): x is string => typeof x === 'string')
    : []
  const totalScu = Math.max(1, Number(d.totalScu) || DEFAULT_DRAFT.totalScu)
  const commodity =
    typeof d.commodity === 'string' ? d.commodity : DEFAULT_DRAFT.commodity

  let objectives: DraftObjective[] = []
  if (Array.isArray(d.objectives) && d.objectives.length) {
    objectives = d.objectives
      .map(sanitizeDraftObjective)
      .filter((o): o is DraftObjective => o != null)
  }
  if (!objectives.length) {
    objectives = [
      createEmptyObjective({
        commodity,
        totalScu,
        pickups: pickupIds.map((locationId) => ({ locationId, scu: 0 })),
        dropoffs: dropoffIds.map((locationId) => ({ locationId, scu: 0 })),
      }),
    ]
  }

  return syncDraftFromObjectives({
    code:
      typeof d.code === 'string' && d.code.trim()
        ? clampMissionCode(d.code)
        : DEFAULT_DRAFT.code,
    name: typeof d.name === 'string' ? d.name : DEFAULT_DRAFT.name,
    giver: typeof d.giver === 'string' ? d.giver : '',
    rank,
    pickupIds,
    dropoffIds,
    totalScu,
    maxUnitScu: normalizeCrateSize(Number(d.maxUnitScu) || DEFAULT_DRAFT.maxUnitScu),
    rewardAuec: Math.max(0, Number(d.rewardAuec) || 0),
    commodity,
    objectives,
    demo:
      typeof d.demo === 'boolean'
        ? d.demo
        : typeof d.name === 'string' && /^\(DEMO\)/i.test(d.name.trim()),
  })
}

export function loadAppCache(): AppCache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return {
        ...DEFAULT_APP_CACHE,
        draft: { ...DEFAULT_DRAFT, objectives: [defaultDraftObjective()] },
      }
    const parsed = JSON.parse(raw) as Partial<AppCache>
    const missions = Array.isArray(parsed.missions)
      ? parsed.missions.map(sanitizeMission).filter((m): m is Mission => m != null)
      : []
    // Legacy caches without the flag: treat non-empty as initialized; empty as not
    // (so first visit still gets demos). Explicit false/true from newer saves wins.
    const missionsInitialized =
      typeof parsed.missionsInitialized === 'boolean'
        ? parsed.missionsInitialized
        : missions.length > 0
    return {
      capacityMode: parsed.capacityMode === 'custom' ? 'custom' : 'ship',
      shipId: typeof parsed.shipId === 'string' ? parsed.shipId : '',
      customScu: Math.max(1, Number(parsed.customScu) || DEFAULT_APP_CACHE.customScu),
      startId: typeof parsed.startId === 'string' ? parsed.startId : '',
      draftHaul: isHaulType(parsed.draftHaul) ? parsed.draftHaul : DEFAULT_HAUL_TYPE,
      draft: sanitizeDraft(parsed.draft),
      missions,
      missionsInitialized,
    }
  } catch {
    return {
      ...DEFAULT_APP_CACHE,
      draft: { ...DEFAULT_DRAFT, objectives: [defaultDraftObjective()] },
    }
  }
}

export function saveAppCache(partial: AppCache): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(partial))
  } catch {
    // Quota / private mode — ignore
  }
}
