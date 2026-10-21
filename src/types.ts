export type LocationBody = string

export interface Location {
  id: string
  name: string
  shortName: string
  body: LocationBody
  type: 'city' | 'outpost' | 'station' | 'rest' | 'landing'
  /** Position in Gm (UEX meters / 1e9) for routing — same unit as sc-hauling.tools */
  x: number
  y: number
  z: number
  system?: string
  aliases?: string[]
  /**
   * Exterior loading dock / zero-G freight elevator (UEX `has_loading_dock`).
   * True only when UEX reports a loading dock at this place.
   */
  hasExteriorElevator?: boolean
}

export interface Ship {
  id: string
  name: string
  manufacturer: string
  cargoScu: number
  containerSizes?: number[]
}

/** In-game haul contract kinds (rank is separate in the title). */
export type HaulType =
  | 'Local Small Haul'
  | 'Local Medium Haul'
  | 'Planetary Small Haul'
  | 'Planetary Medium Haul'
  | 'Planetary Large Haul'
  | 'Stellar Small Haul'
  | 'Stellar Medium Haul'
  | 'Stellar Large Haul'
  | 'Interstellar Small Haul'
  | 'Interstellar Medium Haul'
  | 'Interstellar Large Haul'

/** In-game hauling contract ranks. */
export type HaulRank =
  | 'Trainee'
  | 'Rookie'
  | 'Junior'
  | 'Experienced'
  | 'Senior'
  | 'Expert'
  | 'Master'

/** @deprecated use HaulType */
export type MissionType = HaulType

export interface MissionStop {
  locationId: string
  /** Planned or confirmed SCU at this stop */
  scu: number
  /** User confirmed actual amount on site — following stops re-spread around this */
  confirmed?: boolean
}

/** One commodity leg within a mission (cargo source of truth). */
export interface MissionObjective {
  id: string
  commodity: string
  totalScu: number
  pickups: MissionStop[]
  dropoffs: MissionStop[]
}

export interface Mission {
  id: string
  /** Short label e.g. c01, c02 — stable while the mission is in the list */
  code: string
  name: string
  /** In-game haul kind: Stellar Medium Haul, Planetary, Interstellar, … */
  haulType: HaulType
  /** Contract rank: Trainee, Rookie, Junior, … */
  rank?: HaulRank | string
  /** Contract giver / org from OCR */
  giver?: string
  /** Aggregated from objectives (first / joined) for list display */
  commodity?: string
  rewardAuec?: number
  /** Sum of objective totals */
  totalScu: number
  maxUnitScu: number
  /** Flattened from objectives for legacy UI / amend helpers */
  pickups: MissionStop[]
  dropoffs: MissionStop[]
  /** Cargo legs — source of truth when present */
  objectives: MissionObjective[]
  source: 'manual' | 'ocr' | 'demo'
}

/** Normalized OCR crop rectangles (fractions of image width/height). */
export interface OcrRegionRect {
  x: number
  y: number
  w: number
  h: number
}

export type OcrRegionId = 'title' | 'reward' | 'giver' | 'info' | 'objectives'

export type OcrRegionMap = Record<OcrRegionId, OcrRegionRect>

export type StopKind = 'pickup' | 'dropoff'

export interface RouteStop {
  missionId: string
  missionName: string
  kind: StopKind
  locationId: string
  locationName: string
  cargoDelta: number
  cargoAfter: number
  legDistance: number
  trip: number
  stopRemaining?: number
  /** Individual crate sizes for this action (max-unit breakdown) */
  boxes?: number[]
  commodity?: string
  confirmed?: boolean
}

/** Consecutive route actions at the same place, collapsed for display */
export interface RouteLocationGroup {
  locationId: string
  locationName: string
  trip: number
  legDistance: number
  actions: RouteStop[]
  totalLoad: number
  totalDrop: number
}

export interface OptimizedRoute {
  selectedMissionIds: string[]
  skippedMissionIds: string[]
  stops: RouteStop[]
  totalDistance: number
  totalReward: number
  totalCargoScu: number
  capacityScu: number
  tripCount: number
  method: 'exact' | 'heuristic' | 'multitrip'
  peakLoad: number
}
