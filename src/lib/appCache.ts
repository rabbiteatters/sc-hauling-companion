import {
  DEFAULT_HAUL_RANK,
  DEFAULT_HAUL_TYPE,
  HAUL_RANKS,
  HAUL_TYPES,
  parseHaulRank,
} from './haulTypes'
import { clampMissionCode, DEFAULT_MAX_UNIT_SCU, normalizeCrateSize } from './spread'
import type { HaulType, Mission } from '../types'

const STORAGE_KEY = 'sc-hauling-app-cache-v1'

export type CapacityMode = 'ship' | 'custom'

export interface DraftCache {
  code: string
  name: string
  giver: string
  rank: string
  pickupIds: string[]
  dropoffIds: string[]
  totalScu: number
  maxUnitScu: number
  rewardAuec: number
  commodity: string
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
  demo: false,
}

export const DEFAULT_APP_CACHE: AppCache = {
  capacityMode: 'ship',
  shipId: '',
  customScu: 196,
  startId: '',
  draftHaul: DEFAULT_HAUL_TYPE,
  draft: { ...DEFAULT_DRAFT },
  missions: [],
  missionsInitialized: false,
}

function isHaulType(v: unknown): v is HaulType {
  return typeof v === 'string' && (HAUL_TYPES as string[]).includes(v)
}

function sanitizeMission(raw: unknown): Mission | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Partial<Mission>
  if (!m.id || !m.name || !Array.isArray(m.pickups) || !Array.isArray(m.dropoffs)) return null
  const haulType = isHaulType(m.haulType) ? m.haulType : DEFAULT_HAUL_TYPE
  const rankRaw = typeof m.rank === 'string' ? m.rank.trim() : ''
  const rank =
    rankRaw ||
    parseHaulRank(String(m.name)) ||
    undefined
  return {
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
    pickups: m.pickups
      .filter((p) => p && typeof p.locationId === 'string')
      .map((p) => ({
        locationId: p.locationId,
        scu: Math.max(0, Number(p.scu) || 0),
        confirmed: Boolean(p.confirmed),
      })),
    dropoffs: m.dropoffs
      .filter((d) => d && typeof d.locationId === 'string')
      .map((d) => ({
        locationId: d.locationId,
        scu: Math.max(0, Number(d.scu) || 0),
      })),
    source:
      m.source === 'ocr' || m.source === 'demo' || m.source === 'manual' ? m.source : 'manual',
  }
}

function sanitizeDraft(raw: unknown): DraftCache {
  const d = raw && typeof raw === 'object' ? (raw as Partial<DraftCache>) : {}
  const rank =
    typeof d.rank === 'string' && d.rank.trim()
      ? d.rank.trim()
      : parseHaulRank(typeof d.name === 'string' ? d.name : '') || DEFAULT_DRAFT.rank
  return {
    code:
      typeof d.code === 'string' && d.code.trim()
        ? clampMissionCode(d.code)
        : DEFAULT_DRAFT.code,
    name: typeof d.name === 'string' ? d.name : DEFAULT_DRAFT.name,
    giver: typeof d.giver === 'string' ? d.giver : '',
    rank,
    pickupIds: Array.isArray(d.pickupIds)
      ? d.pickupIds.filter((x): x is string => typeof x === 'string')
      : [],
    dropoffIds: Array.isArray(d.dropoffIds)
      ? d.dropoffIds.filter((x): x is string => typeof x === 'string')
      : [],
    totalScu: Math.max(1, Number(d.totalScu) || DEFAULT_DRAFT.totalScu),
    maxUnitScu: normalizeCrateSize(Number(d.maxUnitScu) || DEFAULT_DRAFT.maxUnitScu),
    rewardAuec: Math.max(0, Number(d.rewardAuec) || 0),
    commodity: typeof d.commodity === 'string' ? d.commodity : DEFAULT_DRAFT.commodity,
    demo:
      typeof d.demo === 'boolean'
        ? d.demo
        : typeof d.name === 'string' && /^\(DEMO\)/i.test(d.name.trim()),
  }
}

export function loadAppCache(): AppCache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_APP_CACHE, draft: { ...DEFAULT_DRAFT } }
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
    return { ...DEFAULT_APP_CACHE, draft: { ...DEFAULT_DRAFT } }
  }
}

export function saveAppCache(partial: AppCache): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(partial))
  } catch {
    // Quota / private mode — ignore
  }
}
