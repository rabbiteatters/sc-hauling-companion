import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import {
  MissionModal,
  type MissionModalStep,
  type OcrBatchItem,
} from './components/MissionModal'
import { RouteSummary } from './components/RouteSummary'

function LockIcon() {
  return (
    <svg className="lock-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden>
      <path
        fill="currentColor"
        d="M7 10V7a5 5 0 0 1 10 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1zm2 0h6V7a3 3 0 0 0-6 0v3z"
      />
    </svg>
  )
}
import { FieldClearButton } from './components/FieldClearButton'
import { ShipPicker } from './components/ShipPicker'
import { StartLocationPicker } from './components/StartLocationPicker'
import { DEMO_MISSION_COUNT, createDemoMissions } from './data/demoMissions'
import {
  createScmdbDemoMission,
  loadScmdbHaulCatalog,
  startScmdbRefreshSchedule,
} from './lib/scmdbDemo'
import { syncGiversFromScmdb } from './store/catalog'
import { useCatalog } from './hooks/useCatalog'
import {
  loadAppCache,
  saveAppCache,
  syncDraftFromObjectives,
  type CapacityMode,
} from './lib/appCache'
import {
  hashHasShare,
  loadRouteSession,
  readShareHash,
  saveRouteSession,
  withAutoMissionNames,
  type ShareSnapshot,
} from './lib/share'
import {
  claimLiveRoom,
  editShareUrl,
  isLiveOrigin,
  liveAccessFromHash,
  liveClientId,
  liveSnapKey,
  loadLiveRoom,
  markLiveOrigin,
  runShareUrl,
  startLiveLink,
  viewShareUrl,
  type LiveConnection,
  type LiveRole,
} from './lib/liveShare'
import { buildAutoMissionName } from './lib/haulTypes'
import {
  createEmptyObjective,
  legacyMissionToObjectives,
  missionCommodityLabel,
  missionTotalScu,
  withObjectiveAggregates,
  objectiveRouteParts,
  objectivesHaveErrors,
} from './lib/objectives'
import { parseMissionText, readMissionImage } from './lib/ocr'
import { formatHoldCapacity, moveRouteGroup, optimizeRoute, optimizeRouteFollowing, repairMissionLocations, resequenceRouteStops } from './lib/optimizer'
import {
  actionKeysForGroups,
  actionMarkKey,
  completedMissionIds,
  fullyDoneGroupIndexes,
  followingDoneIndices,
  groupRouteByLocation,
  leadingDoneCount,
  remapActionMarks,
} from './lib/routeGroups'
import {
  DEFAULT_MAX_UNIT_SCU,
  amendPickupActual,
  clampMissionCode,
  createMission,
  isMissionEnabled,
  nextDemoMissionCode,
  nextMissionCode,
  normalizeCrateSize,
  sortMissionsByCode,
} from './lib/spread'
import {
  getAllLocations,
  getCatalog,
  getLocation,
  locationLabel,
} from './store/catalog'
import type { HaulType, Mission, OptimizedRoute, RouteStop } from './types'
import './App.css'

const cached = loadAppCache()
const openingShare = hashHasShare()
const storedRoute = openingShare ? null : loadRouteSession()

function initialDoneActions(): Set<string> {
  if (!storedRoute?.route) return new Set()
  const groups = groupRouteByLocation(storedRoute.route.stops)
  if (storedRoute.actions) {
    const live = actionKeysForGroups(
      groups,
      groups.map((_, index) => index),
    )
    return new Set(storedRoute.actions.filter((key) => live.has(key)))
  }
  return actionKeysForGroups(groups, storedRoute.done)
}

function haulTypeLabel(t: HaulType): string {
  return t
}

/** Horizontal marquee when the mission name overflows its row. */
function AutoScrollName({ text }: { text: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const wrap = wrapRef.current
    const el = textRef.current
    if (!wrap || !el) return
    const check = () => {
      const dist = Math.max(0, el.scrollWidth - wrap.clientWidth)
      setOverflow(dist > 1)
      wrap.style.setProperty('--scroll-dist', `${dist}px`)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [text])

  return (
    <div
      ref={wrapRef}
      className={`mission-name-scroll${overflow ? ' is-overflow' : ''}`}
      title={text}
    >
      <span ref={textRef} className="mission-name">
        {text}
      </span>
    </div>
  )
}

function outerWidth(el: HTMLElement): number {
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return (
    r.width +
    (parseFloat(cs.marginLeft) || 0) +
    (parseFloat(cs.marginRight) || 0)
  )
}

type StopPack = { sepBefore: boolean[]; breakBefore: boolean[] }

function sameStopPack(a: StopPack, b: StopPack): boolean {
  return (
    a.sepBefore.length === b.sepBefore.length &&
    a.sepBefore.every((v, i) => v === b.sepBefore[i]) &&
    a.breakBefore.every((v, i) => v === b.breakBefore[i])
  )
}

/**
 * In/Out locations: pack names + ·. New lines use a 100% flex spacer (not on
 * the name itself) so later names can still share that line with a ·.
 */
function StopLocationList({
  stops,
  getName,
}: {
  stops: { locationId: string; confirmed?: boolean }[]
  getName: (id: string) => string
}) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [packState, setPackState] = useState<StopPack>(() => ({
    sepBefore: stops.map((_, i) => i > 0),
    breakBefore: stops.map(() => false),
  }))

  const labels = useMemo(
    () =>
      stops.map(
        (s) => `${getName(s.locationId)}${s.confirmed ? '✓' : ''}`,
      ),
    [stops, getName],
  )

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const measure = measureRef.current
    if (!wrap || !measure) return

    const packFromMeasure = (): StopPack => {
      const avail = wrap.clientWidth
      const nameEls = [
        ...measure.querySelectorAll<HTMLElement>(':scope > .stop-loc-measure'),
      ]
      const sepEl = measure.querySelector<HTMLElement>(
        ':scope > .stops-sep-measure',
      )
      const sepW = sepEl ? outerWidth(sepEl) : 12
      const sepBefore = labels.map((_, i) => i > 0)
      const breakBefore = labels.map(() => false)
      let used = 0
      for (let i = 0; i < nameEls.length; i++) {
        const el = nameEls[i]
        if (!el) continue
        const w = Math.min(outerWidth(el), avail)
        if (i === 0) {
          used = w
          sepBefore[0] = false
          breakBefore[0] = false
          continue
        }
        if (used + sepW + w <= avail + 0.5) {
          sepBefore[i] = true
          breakBefore[i] = false
          used += sepW + w
        } else {
          // New line, no leading ·. Spacer keeps it from jumping back up.
          sepBefore[i] = false
          breakBefore[i] = true
          used = w
        }
      }
      return { sepBefore, breakBefore }
    }

    const run = () => {
      if (wrap.clientWidth <= 0) return
      const next = packFromMeasure()
      setPackState((prev) => (sameStopPack(prev, next) ? prev : next))
    }

    run()
    const ro = new ResizeObserver(run)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [labels])

  // Strip any · that still landed at the start of a wrapped line (once per pack).
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const chunks = [
      ...wrap.querySelectorAll<HTMLElement>(':scope > .stop-chunk'),
    ]
    if (chunks.length < 2) return

    setPackState((prev) => {
      const sepBefore = [...prev.sepBefore]
      const breakBefore = [...prev.breakBefore]
      let changed = false
      for (let i = 1; i < chunks.length; i++) {
        const el = chunks[i]
        const prevChunk = chunks[i - 1]
        if (!el || !prevChunk) continue
        if (el.offsetTop > prevChunk.offsetTop + 1 && sepBefore[i]) {
          sepBefore[i] = false
          breakBefore[i] = true
          changed = true
        }
      }
      if (!changed) return prev
      const next = { sepBefore, breakBefore }
      return sameStopPack(prev, next) ? prev : next
    })
  }, [labels, packState.sepBefore, packState.breakBefore])

  return (
    <span ref={wrapRef} className="stops-text">
      <span ref={measureRef} className="stops-text-measure" aria-hidden>
        <span className="stops-sep stops-sep-measure">·</span>
        {labels.map((label, i) => (
          <span key={`m-${i}`} className="stop-loc stop-loc-measure">
            {label}
          </span>
        ))}
      </span>
      {stops.map((s, i) => (
        <span key={`${s.locationId}-${i}`} className="stop-unit">
          {packState.breakBefore[i] ? (
            <span className="stop-line-break" aria-hidden />
          ) : null}
          <span className="stop-chunk">
            {packState.sepBefore[i] ? (
              <span className="stops-sep" aria-hidden>
                ·
              </span>
            ) : null}
            <span className="stop-loc">{labels[i]}</span>
          </span>
        </span>
      ))}
    </span>
  )
}

type MissionTagKey = 'scu' | 'commodity' | 'giver' | 'rank' | 'type'

const TAG_FIT_PRIORITY: MissionTagKey[] = [
  'scu',
  'commodity',
  'giver',
  'rank',
  'type',
]
const TAG_DISPLAY_ORDER: MissionTagKey[] = [
  'giver',
  'rank',
  'type',
  'commodity',
  'scu',
]

type MissionTagCandidate = { key: MissionTagKey; label: string }

type MissionTagLayout = {
  avail: number
  widths: Partial<Record<MissionTagKey, number>>
}

function buildMissionTagCandidates(
  mission: Mission,
  typeLabel: (t: HaulType) => string,
): MissionTagCandidate[] {
  const commodity =
    missionCommodityLabel(legacyMissionToObjectives(mission)) ||
    mission.commodity?.trim() ||
    ''
  const list: MissionTagCandidate[] = [
    { key: 'scu', label: `${mission.totalScu} SCU` },
  ]
  if (commodity) list.push({ key: 'commodity', label: commodity })
  if (mission.giver?.trim()) {
    list.push({ key: 'giver', label: mission.giver.trim() })
  }
  if (mission.rank && String(mission.rank).trim()) {
    list.push({ key: 'rank', label: String(mission.rank).trim() })
  }
  if (mission.haulType) {
    list.push({ key: 'type', label: typeLabel(mission.haulType) })
  }
  return list
}

/** Shared tag set: tags that fit in every row (narrowest width, widest labels). */
function computeSharedMissionTagKeys(
  layouts: MissionTagLayout[],
): MissionTagKey[] {
  if (!layouts.length) return ['scu']
  const minAvail = Math.min(...layouts.map((l) => l.avail))
  const gap = 4
  const shown: MissionTagKey[] = []
  let used = 0
  for (const key of TAG_FIT_PRIORITY) {
    const widths = layouts
      .map((l) => l.widths[key])
      .filter((w): w is number => typeof w === 'number' && w > 0)
    if (!widths.length) continue
    const w = Math.max(...widths)
    const next = shown.length === 0 ? w : used + gap + w
    if (next <= minAvail + 0.5 || shown.length === 0) {
      shown.push(key)
      used = next
    } else {
      break
    }
  }
  return shown
}

/** True when any mission has a tag that shared fit dropped. */
function missionTagsAreHiding(
  layouts: MissionTagLayout[],
  sharedKeys: MissionTagKey[],
): boolean {
  const shared = new Set(sharedKeys)
  for (const layout of layouts) {
    for (const key of TAG_FIT_PRIORITY) {
      const w = layout.widths[key]
      if (typeof w === 'number' && w > 0 && !shared.has(key)) return true
    }
  }
  return false
}

function sameTagKeys(a: MissionTagKey[], b: MissionTagKey[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

/** Fit priority: SCU → commodity → giver → rank → type (shared across list). */
function MissionPriorityTags({
  mission,
  typeLabel,
  sharedKeys,
  onLayout,
}: {
  mission: Mission
  typeLabel: (t: HaulType) => string
  sharedKeys: MissionTagKey[]
  onLayout: (missionId: string, layout: MissionTagLayout | null) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const candidates = useMemo(
    () => buildMissionTagCandidates(mission, typeLabel),
    [mission, typeLabel],
  )

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const measure = measureRef.current
    if (!wrap || !measure) return

    const report = () => {
      const widths: Partial<Record<MissionTagKey, number>> = {}
      for (const c of candidates) {
        const el = measure.querySelector<HTMLElement>(`[data-tag="${c.key}"]`)
        if (el) widths[c.key] = el.offsetWidth
      }
      onLayout(mission.id, { avail: wrap.clientWidth, widths })
    }

    report()
    const ro = new ResizeObserver(report)
    ro.observe(wrap)
    return () => {
      ro.disconnect()
      onLayout(mission.id, null)
    }
  }, [candidates, mission.id, onLayout])

  const byKey = new Map(candidates.map((c) => [c.key, c]))
  const visible = TAG_DISPLAY_ORDER
    .filter((k) => sharedKeys.includes(k))
    .map((k) => byKey.get(k))
    .filter((c): c is MissionTagCandidate => c != null)

  return (
    <div ref={wrapRef} className="mission-tags">
      <div ref={measureRef} className="mission-tags-measure" aria-hidden>
        {candidates.map((c) => (
          <span key={c.key} className="tag" data-tag={c.key}>
            {c.label}
          </span>
        ))}
      </div>
      <div className="mission-meta-track">
        {visible.map((c) => (
          <span
            key={c.key}
            className={`tag${c.key === 'scu' ? ' mission-scu-tag' : ''}`}
          >
            {c.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  const catalog = useCatalog()
  const [capacityMode, setCapacityMode] = useState<CapacityMode>(cached.capacityMode)
  const [shipId, setShipId] = useState(cached.shipId)
  const [customScu, setCustomScu] = useState(cached.customScu)
  const [startId, setStartId] = useState(cached.startId)
  const [missions, setMissions] = useState<Mission[]>(cached.missions)
  const [missionsInitialized, setMissionsInitialized] = useState(
    cached.missionsInitialized,
  )
  const [undoStack, setUndoStack] = useState<Mission[][]>([])
  const [redoStack, setRedoStack] = useState<Mission[][]>([])
  const [modalStep, setModalStep] = useState<MissionModalStep | null>(null)
  const [editingMissionId, setEditingMissionId] = useState<string | null>(null)
  const [route, setRoute] = useState<OptimizedRoute | null>(storedRoute?.route ?? null)
  const [doneActions, setDoneActions] = useState<Set<string>>(initialDoneActions)
  const routeGroups = useMemo(
    () => (route ? groupRouteByLocation(route.stops) : []),
    [route],
  )
  const doneGroups = useMemo(
    () => fullyDoneGroupIndexes(routeGroups, doneActions),
    [routeGroups, doneActions],
  )
  const finishedMissionIds = useMemo(
    () => completedMissionIds(routeGroups, doneActions),
    [routeGroups, doneActions],
  )
  const [routeRearrange, setRouteRearrange] = useState(false)
  const [routeStep, setRouteStep] = useState(storedRoute?.step ?? 0)
  const [shareGate, setShareGate] = useState<'wait' | 'done'>(
    openingShare ? 'wait' : 'done',
  )
  const [shareLinks, setShareLinks] = useState<{ edit: string; run: string; view: string } | null>(
    null,
  )
  const [copiedLink, setCopiedLink] = useState<'edit' | 'run' | 'view' | ''>('')
  const [pageHash, setPageHash] = useState(() =>
    typeof location === 'undefined' ? '' : location.hash,
  )
  const [liveConn, setLiveConn] = useState<LiveConnection>('offline')
  const liveHandle = useRef<{ publish: () => void; close: () => void } | null>(null)
  const liveStatusRef = useRef<ShareSnapshot | null>(null)
  const applyLiveRef = useRef<(snap: ShareSnapshot) => void>(() => {})
  const viewIdRef = useRef<string | null>(null)
  const runKeyRef = useRef<string | null>(null)
  const lastRemoteKey = useRef('')
  const liveSeenRemote = useRef(false)
  const viewOnlyRef = useRef(false)
  const lockPlanRef = useRef(false)
  const [configCollapsed, setConfigCollapsed] = useState(false)
  const [missionsCollapsed, setMissionsCollapsed] = useState(false)
  const [missionsRearrangeMode, setMissionsRearrangeMode] = useState(false)
  const [sharedMissionTagKeys, setSharedMissionTagKeys] = useState<
    MissionTagKey[]
  >(['scu'])
  const missionTagLayoutsRef = useRef(new Map<string, MissionTagLayout>())
  /** Edit/Remove icon+label when wide enough and no tags are being dropped. */
  const [missionActionText, setMissionActionText] = useState(false)
  const missionTagsHidingRef = useRef(false)
  const missionListRef = useRef<HTMLUListElement>(null)
  const missionActionProbeRef = useRef<HTMLDivElement>(null)
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false)
  const [restHere, setRestHere] = useState<{
    currentStep: number
    options: { locationId: string; name: string }[]
    selectedId: string
  } | null>(null)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrStatus, setOcrStatus] = useState('')
  const [ocrPending, setOcrPending] = useState<{
    items: OcrBatchItem[]
    index: number
    applyToMissionId?: string | null
    batchTotal: number
    batchDone: number
  } | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [draftHaul, setDraftHaul] = useState<HaulType>(cached.draftHaul)
  const [draft, setDraft] = useState(cached.draft)
  /** Bumps when OCR fills the form so pickers remount with fresh selection */
  const [ocrFormKey, setOcrFormKey] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const cacheReady = useRef(false)
  const shipInitDone = useRef(false)
  const shareShipFallback = useRef<{ name: string; capacityScu: number } | null>(null)
  const shareNeedsRoute = useRef(false)
  const ocrCancelRef = useRef(false)
  const lastOcrFillSig = useRef('')
  /** First fill of a batch can keep a code typed before import. Later images use their own. */
  const ocrFilledOnce = useRef(false)
  const demoIndexRef = useRef(
    cached.missions.filter((m) => m.source === 'demo').length,
  )

  function clearPlannedRoute() {
    setRoute(null)
    setDoneActions(new Set())
    setRouteRearrange(false)
    setRouteStep(0)
    setRestHere(null)
  }

  function openShare() {
    const access = liveAccessFromHash(location.hash)
    const stored = access && access.role !== 'view' ? loadLiveRoom() : null
    const sameRoom = stored && access && access.role !== 'view' && stored.roomId === access.roomId
    const viewId = sameRoom ? stored.viewId : viewIdRef.current
    setCopiedLink('')
    if (access?.role === 'view') {
      setShareLinks({ edit: '', run: '', view: viewShareUrl(access.viewId) })
      return
    }
    if (access?.role === 'run') {
      setShareLinks({
        edit: '',
        run: runShareUrl(access),
        view: viewId ? viewShareUrl(viewId) : '',
      })
      return
    }
    if (access?.role === 'edit') {
      const runKey = sameRoom ? stored.runKey : runKeyRef.current
      setShareLinks({
        edit: editShareUrl(access),
        run: runKey ? runShareUrl({ roomId: access.roomId, runKey }) : '',
        view: viewId ? viewShareUrl(viewId) : '',
      })
      return
    }
    const room = claimLiveRoom()
    markLiveOrigin(room.roomId)
    const edit = editShareUrl(room)
    if (location.hash !== new URL(edit).hash) {
      history.replaceState(null, '', edit)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
    setShareLinks({
      edit,
      run: runShareUrl(room),
      view: viewShareUrl(room.viewId),
    })
    liveHandle.current?.publish()
  }

  async function copyShareField(kind: 'edit' | 'run' | 'view') {
    const url = shareLinks?.[kind]
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopiedLink(kind)
    } catch {
      setCopiedLink('')
    }
  }

  const capacityScu = useMemo(() => {
    if (capacityMode === 'custom') return Math.max(0, customScu)
    return catalog.ships.find((s) => s.id === shipId)?.cargoScu ?? 0
  }, [capacityMode, customScu, shipId, catalog.ships])

  const activeMissions = useMemo(
    () => missions.filter(isMissionEnabled),
    [missions],
  )
  const activeScu = useMemo(
    () => activeMissions.reduce((s, m) => s + m.totalScu, 0),
    [activeMissions],
  )
  useEffect(() => {
    if (missions.length < 2 && missionsRearrangeMode) {
      setMissionsRearrangeMode(false)
    }
  }, [missions.length, missionsRearrangeMode])

  const labeledActionsWidth = useCallback(() => {
    const probe = missionActionProbeRef.current
    if (!probe) return 72
    const w = Math.ceil(probe.getBoundingClientRect().width)
    return w > 0 ? w : 72
  }, [])

  /**
   * Space priority when narrowing:
   * 1) Keep all tags + icon+text actions if they fit
   * 2) Else drop action text (icons only), keep all tags if they fit
   * 3) Else icons only + hide tags by priority
   */
  const recomputeMissionListChrome = useCallback(() => {
    const ids = new Set(missions.map((m) => m.id))
    for (const id of [...missionTagLayoutsRef.current.keys()]) {
      if (!ids.has(id)) missionTagLayoutsRef.current.delete(id)
    }
    const raw = missions
      .map((m) => missionTagLayoutsRef.current.get(m.id))
      .filter((l): l is MissionTagLayout => l != null)
    if (raw.length < missions.length) return

    const list = missionListRef.current
    const listW = list?.clientWidth ?? 0
    if (listW <= 0) return

    const chrome = 48
    const labeledW = labeledActionsWidth()
    const iconActionsW = 32

    const layoutsFor = (actionsW: number): MissionTagLayout[] => {
      const avail = Math.max(0, listW - chrome - actionsW - 8)
      return raw.map((l) => ({ ...l, avail }))
    }

    const withLabels = layoutsFor(labeledW)
    const keysWithLabels = computeSharedMissionTagKeys(withLabels)
    if (!missionTagsAreHiding(withLabels, keysWithLabels)) {
      missionTagsHidingRef.current = false
      setSharedMissionTagKeys((prev) =>
        sameTagKeys(prev, keysWithLabels) ? prev : keysWithLabels,
      )
      setMissionActionText((prev) => (prev ? prev : true))
      return
    }

    // Not enough for labels — icons only, then hide tags only if still needed
    const withIcons = layoutsFor(iconActionsW)
    const keysWithIcons = computeSharedMissionTagKeys(withIcons)
    const hiding = missionTagsAreHiding(withIcons, keysWithIcons)
    missionTagsHidingRef.current = hiding
    setSharedMissionTagKeys((prev) =>
      sameTagKeys(prev, keysWithIcons) ? prev : keysWithIcons,
    )
    setMissionActionText((prev) => (prev ? false : prev))
  }, [missions, labeledActionsWidth])

  const onMissionTagLayout = useCallback(
    (missionId: string, layout: MissionTagLayout | null) => {
      if (layout) {
        const prev = missionTagLayoutsRef.current.get(missionId)
        // Ignore ephemeral avail from the row; chrome recompute supplies stable avail.
        if (
          prev &&
          TAG_FIT_PRIORITY.every((k) => prev.widths[k] === layout.widths[k])
        ) {
          return
        }
        missionTagLayoutsRef.current.set(missionId, layout)
      } else {
        missionTagLayoutsRef.current.delete(missionId)
      }
      recomputeMissionListChrome()
    },
    [recomputeMissionListChrome],
  )

  useLayoutEffect(() => {
    if (missionsCollapsed) {
      setMissionActionText(false)
      return
    }
    const list = missionListRef.current
    const probe = missionActionProbeRef.current
    if (!list || !probe) return

    const ro = new ResizeObserver(() => {
      recomputeMissionListChrome()
    })
    ro.observe(list)
    ro.observe(probe)
    recomputeMissionListChrome()
    return () => ro.disconnect()
  }, [missions.length, missionsCollapsed, recomputeMissionListChrome])

  // Persist all selectable choices, plus the planned route so a shared link
  // still matches after the hash is cleared.
  useEffect(() => {
    if (shareGate === 'wait' || viewOnlyRef.current) return
    saveRouteSession({
      route,
      done: [...doneGroups],
      actions: [...doneActions],
      step: routeStep,
    })
    if (!cacheReady.current) {
      // Skip the first paint so we don't overwrite cache before hydration finishes
      cacheReady.current = true
      return
    }
    saveAppCache({
      capacityMode,
      shipId,
      customScu,
      startId,
      draftHaul,
      draft,
      missions,
      missionsInitialized,
    })
  }, [
    capacityMode,
    shipId,
    customScu,
    startId,
    draftHaul,
    draft,
    missions,
    missionsInitialized,
    route,
    doneGroups,
    doneActions,
    routeStep,
    shareGate,
  ])

  function applyShareSnapshot(snap: ShareSnapshot) {
    let capacityMode = snap.capacityMode
    let shipId = snap.shipId
    let customScu = snap.customScu
    const ships = getCatalog().ships
    if (capacityMode === 'ship' && ships.length && !ships.some((s) => s.id === shipId)) {
      const named = snap.shipName
        ? ships.find((s) => s.name === snap.shipName)
        : undefined
      if (named) shipId = named.id
      else if (snap.capacityScu > 0) {
        capacityMode = 'custom'
        customScu = snap.capacityScu
      }
    }
    shareShipFallback.current =
      capacityMode === 'ship' && !ships.length
        ? { name: snap.shipName, capacityScu: snap.capacityScu }
        : null
    setCapacityMode(capacityMode)
    setShipId(shipId)
    setCustomScu(customScu)
    setStartId(snap.startId)
    setMissions(snap.missions)
    setMissionsInitialized(true)
    demoIndexRef.current = snap.missions.filter((m) => m.source === 'demo').length
    setUndoStack([])
    setRedoStack([])
    setRoute(snap.route)
    shareNeedsRoute.current = !snap.route
    const groups = snap.route ? groupRouteByLocation(snap.route.stops) : []
    const known = actionKeysForGroups(
      groups,
      groups.map((_, index) => index),
    )
    const sharedMarks =
      Array.isArray(snap.actions) && snap.route
        ? new Set(snap.actions.filter((key) => known.has(key)))
        : snap.route
          ? actionKeysForGroups(groups, snap.done)
          : new Set<string>()
    setDoneActions(sharedMarks)
    setRouteRearrange(false)
    setRouteStep(snap.step)
    setRestHere(null)
    saveAppCache({
      capacityMode,
      shipId,
      customScu,
      startId: snap.startId,
      draftHaul: cached.draftHaul,
      draft: cached.draft,
      missions: snap.missions,
      missionsInitialized: true,
    })
    saveRouteSession({
      route: snap.route,
      done: snap.done,
      actions: [...sharedMarks],
      step: snap.step,
    })
  }

  applyLiveRef.current = applyShareSnapshot
  const shipForLive = catalog.ships.find((s) => s.id === shipId)
  liveStatusRef.current = {
    capacityMode,
    shipId,
    shipName: shipForLive?.name ?? '',
    customScu,
    capacityScu,
    startId,
    missions,
    route,
    done: [...doneGroups],
    actions: [...doneActions],
    step: routeStep,
  }
  const liveAccess = liveAccessFromHash(pageHash)
  const liveRole: LiveRole | null = liveAccess?.role ?? null
  const viewOnly = liveRole === 'view'
  const lockPlan = liveRole === 'view' || liveRole === 'run'
  viewOnlyRef.current = viewOnly
  lockPlanRef.current = lockPlan
  if (liveAccess?.role === 'edit' && isLiveOrigin(liveAccess.roomId)) {
    liveSeenRemote.current = true
  }

  useEffect(() => {
    let generation = 0
    async function loadShareFromHash() {
      const token = ++generation
      const hash = location.hash
      setPageHash(hash)
      if (!hashHasShare(hash)) {
        if (token === generation) setShareGate('done')
        return
      }
      const snap = await readShareHash(hash)
      if (token !== generation) return
      if (snap) applyShareSnapshot(snap)
      if (location.hash === hash) {
        history.replaceState(null, '', `${location.pathname}${location.search}`)
      }
      setShareGate('done')
    }
    void loadShareFromHash()
    window.addEventListener('hashchange', loadShareFromHash)
    return () => {
      generation += 1
      window.removeEventListener('hashchange', loadShareFromHash)
    }
    // Apply whenever a share hash arrives, including a link opened in this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!catalog.loadedAt) return
    setMissions((prev) => withAutoMissionNames(prev))
  }, [catalog.loadedAt, catalog.locations])

  useEffect(() => {
    if (!shareNeedsRoute.current) return
    if (shareGate !== 'done' || !catalog.loadedAt || !startId) return
    if (!getLocation(startId)) return
    const titled = withAutoMissionNames(missions)
    if (titled !== missions) {
      setMissions(titled)
      return
    }
    shareNeedsRoute.current = false
    const ready = repairMissionLocations(titled)
    if (ready !== titled) setMissions(ready)
    setRoute(optimizeRoute(ready.filter(isMissionEnabled), startId, capacityScu))
    setRouteRearrange(false)
  }, [shareGate, catalog.loadedAt, startId, missions, capacityScu])

  useEffect(() => {
    const access = liveAccessFromHash(pageHash)
    if (!access) {
      liveHandle.current?.close()
      liveHandle.current = null
      return
    }
    const eager = access.role === 'edit' && isLiveOrigin(access.roomId)
    if (!eager) {
      liveSeenRemote.current = false
      lastRemoteKey.current = ''
    }
    const handle = startLiveLink({
      role: access.role,
      topicId: access.role === 'view' ? access.viewId : access.roomId,
      clientId: liveClientId(),
      eager,
      getViewId: () => {
        if (access.role === 'view') return null
        const stored = loadLiveRoom()
        if (stored?.roomId === access.roomId) return stored.viewId
        return viewIdRef.current
      },
      getRunKey: () => {
        if (access.role === 'run') return access.runKey
        if (access.role !== 'edit') return null
        const stored = loadLiveRoom()
        if (stored?.roomId === access.roomId) return stored.runKey
        return runKeyRef.current
      },
      getStatus: () =>
        liveStatusRef.current ?? {
          capacityMode,
          shipId,
          shipName: '',
          customScu,
          capacityScu,
          startId,
          missions,
          route,
          done: [],
          actions: [],
          step: 0,
        },
      onStatus: (snap, viewId, runKey) => {
        if (viewId) {
          viewIdRef.current = viewId
          setShareLinks((current) =>
            current && (current.edit || current.run) && !current.view
              ? { ...current, view: viewShareUrl(viewId) }
              : current,
          )
        }
        if (runKey && access.role === 'edit') {
          runKeyRef.current = runKey
          setShareLinks((current) =>
            current && current.edit && !current.run
              ? { ...current, run: runShareUrl({ roomId: access.roomId, runKey }) }
              : current,
          )
        }
        lastRemoteKey.current = liveSnapKey(snap)
        liveSeenRemote.current = true
        applyLiveRef.current(snap)
      },
      onConnection: setLiveConn,
    })
    liveHandle.current = handle
    return () => {
      handle.close()
      if (liveHandle.current === handle) liveHandle.current = null
    }
    // Restart only when the link in the address bar changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageHash])

  useEffect(() => {
    if (liveRole !== 'edit' && liveRole !== 'run') return
    if (!liveSeenRemote.current) return
    const timer = window.setTimeout(() => {
      const current = liveStatusRef.current
      if (!current) return
      const key = liveSnapKey(current)
      if (key === lastRemoteKey.current) return
      lastRemoteKey.current = key
      liveHandle.current?.publish()
    }, 400)
    return () => window.clearTimeout(timer)
  }, [
    liveRole,
    missions,
    route,
    doneActions,
    doneGroups,
    routeStep,
    shipId,
    startId,
    capacityMode,
    customScu,
    capacityScu,
  ])

  useEffect(() => {
    if (!copiedLink) return
    const timer = window.setTimeout(() => setCopiedLink(''), 2000)
    return () => window.clearTimeout(timer)
  }, [copiedLink])

  // Fill missing selects once catalog arrives (keep cached values when still valid)
  useEffect(() => {
    if (shareGate !== 'done' || !catalog.loadedAt) return

    const shipOk = Boolean(shipId && catalog.ships.some((s) => s.id === shipId))
    if (shipOk) {
      shipInitDone.current = true
      shareShipFallback.current = null
    } else if (shareShipFallback.current) {
      const fallback = shareShipFallback.current
      shareShipFallback.current = null
      const named = fallback.name
        ? catalog.ships.find((s) => s.name === fallback.name)
        : undefined
      if (named) {
        setShipId(named.id)
        shipInitDone.current = true
      } else if (fallback.capacityScu > 0) {
        setCapacityMode('custom')
        setCustomScu(fallback.capacityScu)
        shipInitDone.current = true
      } else if (shipId || !shipInitDone.current) {
        const c2 = catalog.ships.find((s) => /C2 Hercules/i.test(s.name))
        const max = catalog.ships.find((s) => /Freelancer MAX/i.test(s.name))
        setShipId(c2?.id ?? max?.id ?? catalog.ships[0]?.id ?? '')
        shipInitDone.current = true
      }
    } else if (shipId || !shipInitDone.current) {
      // Stale id, or first catalog load with empty selection — pick a default.
      // After init, an empty shipId means the user cleared it (0 SCU hold).
      const c2 = catalog.ships.find((s) => /C2 Hercules/i.test(s.name))
      const max = catalog.ships.find((s) => /Freelancer MAX/i.test(s.name))
      setShipId(c2?.id ?? max?.id ?? catalog.ships[0]?.id ?? '')
      shipInitDone.current = true
    }

    if (!startId || !getLocation(startId)) {
      const ruin = catalog.locations.find((l) => /Ruin Station/i.test(l.name))
      setStartId(ruin?.id ?? catalog.locations[0]?.id ?? '')
    }

    // Don't clobber an in-progress OCR/manual draft when the catalog refreshes
    if (modalStep) return

    const validPickups = draft.pickupIds.filter((id) => getLocation(id))
    const validDropoffs = draft.dropoffIds.filter((id) => getLocation(id))
    if (!validDropoffs.length || validPickups.length !== draft.pickupIds.length) {
      const ruin = catalog.locations.find((l) => /Ruin Station/i.test(l.name))
      const star = catalog.locations.find((l) => /Starlight/i.test(l.name))
      setDraft((d) => {
        const pickupIds = validPickups.length
          ? validPickups
          : star
            ? [star.id]
            : d.pickupIds
        const dropoffIds = validDropoffs.length
          ? validDropoffs
          : ruin
            ? [ruin.id]
            : catalog.locations[0]
              ? [catalog.locations[0].id]
              : []
        const objectives = (d.objectives?.length
          ? d.objectives
          : [createEmptyObjective({ commodity: d.commodity, totalScu: d.totalScu })]
        ).map((o, i) => {
          if (i > 0) {
            return {
              ...o,
              pickups: o.pickups.filter((p) => getLocation(p.locationId)),
              dropoffs: o.dropoffs.filter((x) => getLocation(x.locationId)),
            }
          }
          return {
            ...o,
            pickups: pickupIds.map((locationId) => {
              const prev = o.pickups.find((p) => p.locationId === locationId)
              return prev ?? { locationId, scu: 0 }
            }),
            dropoffs: dropoffIds.map((locationId) => {
              const prev = o.dropoffs.find((x) => x.locationId === locationId)
              return prev ?? { locationId, scu: 0 }
            }),
          }
        })
        return syncDraftFromObjectives({ ...d, pickupIds, dropoffIds, objectives })
      })
    }

    // Only auto-seed demos on first visit — never after purge/remove
    if (!missionsInitialized) {
      setMissions(createDemoMissions())
      demoIndexRef.current = DEMO_MISSION_COUNT
      setMissionsInitialized(true)
    }
  }, [catalog.loadedAt, catalog.ships, catalog.locations, shareGate])

  const runOcrFilesRef = useRef<
    (files: Array<File | Blob>, opts?: { applyToMissionId?: string | null }) => Promise<void>
  >(async () => {})
  const ocrBusyRef = useRef(ocrBusy)
  ocrBusyRef.current = ocrBusy

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (lockPlanRef.current || ocrBusyRef.current) return
      const files = [...(e.clipboardData?.items ?? [])]
        .filter((i) => i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => Boolean(f))
      if (!files.length) return
      e.preventDefault()
      void runOcrFilesRef.current(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  const UNDO_LIMIT = 10

  function cloneMissions(list: Mission[]): Mission[] {
    return list.map((m) => ({ ...m }))
  }

  function pushMissionUndo(snapshot: Mission[]) {
    setUndoStack((stack) => [...stack, cloneMissions(snapshot)].slice(-UNDO_LIMIT))
    setRedoStack([])
  }

  function undoMissionChange() {
    if (!undoStack.length) return
    const restore = undoStack[undoStack.length - 1]
    setRedoStack((stack) => [...stack, cloneMissions(missions)].slice(-UNDO_LIMIT))
    setUndoStack((stack) => stack.slice(0, -1))
    setMissions(restore)
    setMissionsInitialized(true)
    clearPlannedRoute()
  }

  function redoMissionChange() {
    if (!redoStack.length) return
    const restore = redoStack[redoStack.length - 1]
    setUndoStack((stack) => [...stack, cloneMissions(missions)].slice(-UNDO_LIMIT))
    setRedoStack((stack) => stack.slice(0, -1))
    setMissions(restore)
    setMissionsInitialized(true)
    clearPlannedRoute()
  }

  function fillDraftFromMission(m: Mission | null | undefined, keepCode = false) {
    if (!m) {
      setDraftHaul(cached.draftHaul)
      setDraft(
        syncDraftFromObjectives({
          code: nextMissionCode(missions),
          name: '',
          giver: '',
          rank: '',
          pickupIds: [],
          dropoffIds: [],
          totalScu: 1,
          maxUnitScu: DEFAULT_MAX_UNIT_SCU,
          rewardAuec: 0,
          commodity: '',
          objectives: [createEmptyObjective({ commodity: '', totalScu: 0 })],
          demo: false,
        }),
      )
    } else {
      const isDemo = m.source === 'demo'
      const objectives = legacyMissionToObjectives(m).map((o) =>
        createEmptyObjective(o),
      )
      const route = objectiveRouteParts(objectives)
      setDraftHaul(m.haulType)
      setDraft(
        syncDraftFromObjectives({
          code: isDemo
            ? nextDemoMissionCode(missions)
            : keepCode
              ? draft.code || m.code || nextMissionCode(missions)
              : m.code || draft.code || nextMissionCode(missions),
          // Demo uses auto title with (DEMO) prefix; OCR/manual keep parsed name
          name: isDemo
            ? buildAutoMissionName({
                giver: m.giver,
                rank: m.rank,
                haulType: m.haulType,
                from: route.from,
                to: route.to,
                pickupCount: route.pickupCount,
                dropoffCount: route.dropoffCount,
                demo: true,
              })
            : m.name,
          giver: m.giver ?? '',
          rank: m.rank ?? '',
          pickupIds: [],
          dropoffIds: [],
          totalScu: missionTotalScu(objectives) || m.totalScu,
          maxUnitScu: normalizeCrateSize(m.maxUnitScu),
          rewardAuec: m.rewardAuec ?? 0,
          commodity: missionCommodityLabel(objectives) || m.commodity || '',
          objectives,
          demo: isDemo,
        }),
      )
    }
    setOcrFormKey((k) => k + 1)
  }

  /** Form values for the image currently on screen. Edits win over the scan. */
  function missionFromDraft(scanned?: Mission): Mission {
    const objectives = (draft.objectives ?? []).map((o) => createEmptyObjective(o))
    const route = objectiveRouteParts(objectives)
    const total = Math.max(
      1,
      missionTotalScu(objectives) || Number(draft.totalScu) || scanned?.totalScu || 1,
    )
    const isDemo = Boolean(draft.demo) || draft.name.trim().startsWith('(DEMO)')
    const autoName = buildAutoMissionName({
      giver: draft.giver.trim(),
      rank: draft.rank.trim(),
      haulType: draftHaul,
      from: route.from,
      to: route.to,
      pickupCount: route.pickupCount,
      dropoffCount: route.dropoffCount,
      demo: isDemo,
    })
    return createMission({
      id: scanned?.id,
      code:
        clampMissionCode(draft.code) ||
        scanned?.code ||
        (isDemo ? nextDemoMissionCode(missions) : nextMissionCode(missions)),
      name:
        draft.name.trim() ||
        autoName ||
        `Haul ${total} SCU → ${route.to}`,
      haulType: draftHaul,
      rank: draft.rank.trim() || undefined,
      giver: draft.giver.trim() || undefined,
      pickupIds: objectives.flatMap((o) => o.pickups.map((p) => p.locationId)),
      dropoffIds: objectives.flatMap((o) => o.dropoffs.map((d) => d.locationId)),
      totalScu: total,
      maxUnitScu: normalizeCrateSize(draft.maxUnitScu || DEFAULT_MAX_UNIT_SCU),
      rewardAuec: draft.rewardAuec > 0 ? draft.rewardAuec : undefined,
      commodity: missionCommodityLabel(objectives) || draft.commodity.trim() || undefined,
      objectives,
      source: scanned?.source ?? (isDemo ? 'demo' : 'manual'),
    })
  }

  function draftHasCargo(): boolean {
    return (draft.objectives ?? []).some(
      (o) => o.pickups.length > 0 || o.dropoffs.length > 0,
    )
  }

  /** Store the open form onto the image it belongs to. */
  function pendingWithCurrentDraft<T extends { items: OcrBatchItem[]; index: number }>(
    pending: T,
  ): T {
    if (!draftHasCargo()) return pending
    const item = pending.items[pending.index]
    if (!item) return pending
    const mission = missionFromDraft(item.missions[0])
    return {
      ...pending,
      items: pending.items.map((it, i) =>
        i === pending.index
          ? { ...it, missions: [mission, ...it.missions.slice(1)] }
          : it,
      ),
    }
  }

  // SCMDB demos + givers: refresh at 00:00 / 06:00 / 12:00 / 18:00 (and via Refresh data)
  useEffect(() => startScmdbRefreshSchedule(() => syncGiversFromScmdb()), [])

  // Keep editable fields in sync with the OCR image currently being previewed
  useEffect(() => {
    if (modalStep !== 'add' || !ocrPending || ocrPending.applyToMissionId) return
    const item = ocrPending.items[ocrPending.index]
    const m = item?.missions[0]
    const objs = m ? legacyMissionToObjectives(m) : []
    const sig = m
      ? [
          ocrPending.index,
          m.id,
          m.name,
          m.totalScu,
          m.commodity ?? '',
          m.maxUnitScu,
          m.rewardAuec ?? 0,
          objs
            .map(
              (o) =>
                `${o.commodity}:${o.totalScu}:${o.pickups.map((p) => `${p.locationId}=${p.scu}`).join('+')}:${o.dropoffs.map((d) => `${d.locationId}=${d.scu}`).join('+')}`,
            )
            .join(';'),
        ].join('|')
      : `${ocrPending.index}|empty|${item?.imageUrl ?? ''}`
    if (sig === lastOcrFillSig.current) return
    const keepCode = !ocrFilledOnce.current
    ocrFilledOnce.current = true
    lastOcrFillSig.current = sig
    fillDraftFromMission(m, keepCode)
  }, [modalStep, ocrPending])

  function addMission() {
    const scanned =
      ocrPending && !ocrPending.applyToMissionId
        ? ocrPending.items[ocrPending.index]?.missions[0]
        : undefined

    const objectives = (draft.objectives ?? []).map((o) => createEmptyObjective(o))
    if (objectivesHaveErrors(objectives)) return

    const mission = missionFromDraft(scanned)
    const code = mission.code
    setMissions((prev) => [...prev, mission])
    setMissionsInitialized(true)
    clearPlannedRoute()
    setDraft((d) => {
      const cursor = [...missions, { code } as Mission]
      return {
        ...d,
        code: d.demo ? nextDemoMissionCode(cursor) : nextMissionCode(cursor),
      }
    })

    // Multi OCR: keep window open and load the next scan into the form
    if (ocrPending && !ocrPending.applyToMissionId && ocrPending.items.length > 1) {
      const { items, index } = ocrPending
      const item = items[index]
      if (item?.imageUrl) URL.revokeObjectURL(item.imageUrl)
      const rest = items.filter((_, i) => i !== index)
      if (rest.length) {
        const nextIndex = Math.min(index, rest.length - 1)
        setOcrPending({ ...ocrPending, items: rest, index: nextIndex })
        lastOcrFillSig.current = ''
        setOcrStatus(`Added · ${rest.length} left`)
        return
      }
    }
    clearOcrPending()
    setModalStep(null)
  }

  function setCargoLoadNote(
    missionId: string,
    commodity: string | undefined,
    note: string,
  ) {
    const trimmed = note.trim().slice(0, 80)
    setMissions((list) =>
      list.map((m) => {
        if (m.id !== missionId) return m
        const wanted = commodity?.trim()
        let matched = false
        const objectives = m.objectives.map((o) => {
          if (wanted && o.commodity.trim() !== wanted) return o
          matched = true
          return { ...o, ...(trimmed ? { loadNote: trimmed } : { loadNote: undefined }) }
        })
        if (!matched && objectives[0]) {
          objectives[0] = {
            ...objectives[0],
            ...(trimmed ? { loadNote: trimmed } : { loadNote: undefined }),
          }
        }
        return withObjectiveAggregates({ ...m, objectives })
      }),
    )
    setMissionsInitialized(true)
  }

  /** Copy the mission's current pickup and drop amounts onto stops we are keeping. */
  function syncKeptCargo(stops: RouteStop[], list: Mission[]): RouteStop[] {
    return stops.map((stop) => {
      const mission = list.find((m) => m.id === stop.missionId)
      if (!mission) return stop
      const wanted = stop.commodity?.trim()
      const objectives = (mission.objectives ?? []).filter(
        (o) => !wanted || o.commodity.trim() === wanted,
      )
      const places = objectives.flatMap((o) =>
        stop.kind === 'pickup' ? o.pickups : o.dropoffs,
      )
      const match = places.find((place) => place.locationId === stop.locationId)
      if (!match) return stop
      const scu = Math.max(0, Math.round(match.scu))
      const cargoDelta = stop.kind === 'pickup' ? scu : -scu
      if (cargoDelta === stop.cargoDelta) return stop
      return { ...stop, cargoDelta }
    })
  }

  /**
   * Keep the run through the current stop and plan only what is still ahead.
   * Falls back to a full route only when there is nothing in progress to keep.
   */
  function replanRestAfterAmend(ready: Mission[]) {
    if (!startId) return
    const enabled = ready.filter(isMissionEnabled)
    const groups = route ? groupRouteByLocation(route.stops) : []
    if (!route || groups.length === 0) {
      setRoute(optimizeRoute(enabled, startId, capacityScu))
      setDoneActions(new Set())
      setRouteRearrange(false)
      setRouteStep(0)
      return
    }
    const safeStep = Math.max(0, Math.min(routeStep, groups.length - 1))
    const kept = syncKeptCargo(
      groups.slice(0, safeStep + 1).flatMap((group) => group.actions),
      ready,
    )
    const resequenced = resequenceRouteStops(kept, startId, capacityScu, {
      ignoreCapacity: true,
    })
    const prefix = resequenced ?? kept
    const fromId = prefix[prefix.length - 1]?.locationId
    const next = fromId
      ? optimizeRouteFollowing(enabled, capacityScu, prefix, fromId, {
          trustCargoAfter: resequenced != null,
        })
      : null
    const stops = next?.stops ?? prefix
    setRoute(
      next ?? {
        ...route,
        stops: prefix,
        method: 'following',
        totalDistance: prefix.reduce((sum, stop) => sum + stop.legDistance, 0),
        peakLoad: prefix.reduce((peak, stop) => Math.max(peak, stop.cargoAfter), 0),
      },
    )
    const restGroups = groupRouteByLocation(stops)
    setRouteStep(Math.max(0, Math.min(safeStep, restGroups.length - 1)))
    setDoneActions((prev) =>
      remapActionMarks(prev, (index) => (index <= safeStep ? index : null)),
    )
    setRouteRearrange(false)
  }

  function amendPickup(
    missionId: string,
    locationId: string,
    actualScu: number,
    boxes: number[] = [],
    commodity?: string,
  ) {
    const wanted = commodity?.trim()
    const previous = missions.find((m) => m.id === missionId)
    const previousStop = previous?.objectives
      .filter((o) => !wanted || o.commodity.trim() === wanted)
      .flatMap((o) => o.pickups)
      .find((p) => p.locationId === locationId)
    const scuChanged = (previousStop?.scu ?? -1) !== Math.max(0, Math.round(actualScu))
    const groups = route ? groupRouteByLocation(route.stops) : []
    const safeStep = groups.length
      ? Math.max(0, Math.min(routeStep, groups.length - 1))
      : -1
    const locked = new Set<string>()
    if (safeStep >= 0) {
      for (const action of groups
        .slice(0, safeStep + 1)
        .flatMap((group) => group.actions)) {
        if (action.kind !== 'pickup' || action.missionId !== missionId) continue
        if (action.locationId === locationId) continue
        if (wanted && action.commodity && action.commodity.trim() !== wanted) continue
        locked.add(action.locationId)
      }
    }
    const next = missions.map((m) =>
      m.id === missionId
        ? amendPickupActual(m, locationId, actualScu, boxes, commodity, locked)
        : m,
    )
    const ready = repairMissionLocations(next)
    setMissions(ready)
    if (startId && scuChanged) replanRestAfterAmend(ready)
  }

  function toggleMissionEnabled(id: string) {
    pushMissionUndo(missions)
    setMissions((list) =>
      list.map((m) =>
        m.id === id ? { ...m, enabled: !isMissionEnabled(m) } : m,
      ),
    )
    setMissionsInitialized(true)
    clearPlannedRoute()
  }

  function moveMission(id: string, delta: -1 | 1) {
    const index = missions.findIndex((m) => m.id === id)
    if (index < 0) return
    const nextIndex = index + delta
    if (nextIndex < 0 || nextIndex >= missions.length) return
    pushMissionUndo(missions)
    const next = [...missions]
    const [item] = next.splice(index, 1)
    next.splice(nextIndex, 0, item)
    setMissions(next)
    setMissionsInitialized(true)
  }

  function sortMissionsByCodeAction() {
    if (missions.length < 2) return
    const sorted = sortMissionsByCode(missions)
    if (sorted.every((m, i) => m.id === missions[i]?.id)) return
    pushMissionUndo(missions)
    setMissions(sorted)
    setMissionsInitialized(true)
  }

  function removeMission(id: string) {
    pushMissionUndo(missions)
    setMissions((m) => m.filter((x) => x.id !== id))
    setMissionsInitialized(true)
    clearPlannedRoute()
  }

  function requestPurgeMissions() {
    if (!missions.length) return
    setPurgeConfirmOpen(true)
  }

  function confirmPurgeMissions() {
    if (!missions.length) {
      setPurgeConfirmOpen(false)
      return
    }
    pushMissionUndo(missions)
    setMissions([])
    setMissionsInitialized(true)
    clearPlannedRoute()
    setPurgeConfirmOpen(false)
  }

  function fillDraftFromDemo() {
    const index = demoIndexRef.current
    demoIndexRef.current = index + 1
    const { hauls } = loadScmdbHaulCatalog()
    fillDraftFromMission(createScmdbDemoMission(hauls, index))
    // Drop any OCR batch so Save uses the filled draft, not a prior scan
    if (ocrPending && !ocrPending.applyToMissionId) {
      for (const item of ocrPending.items) {
        if (item.imageUrl) URL.revokeObjectURL(item.imageUrl)
      }
      setOcrPending(null)
      setOcrStatus('')
      lastOcrFillSig.current = ''
      ocrFilledOnce.current = false
    }
  }

  function saveMission(updated: Mission) {
    setMissions((list) =>
      list.map((m) =>
        m.id === updated.id
          ? {
              ...updated,
              ...(m.enabled === false ? { enabled: false as const } : {}),
            }
          : m,
      ),
    )
    setMissionsInitialized(true)
    setEditingMissionId(null)
    setModalStep(null)
    clearPlannedRoute()
  }

  const editingMission = editingMissionId
    ? missions.find((m) => m.id === editingMissionId) ?? null
    : null

  function runOptimize() {
    if (!startId) return
    const ready = repairMissionLocations(missions)
    if (ready !== missions) setMissions(ready)
    setRoute(optimizeRoute(ready.filter(isMissionEnabled), startId, capacityScu))
    setDoneActions(new Set())
    setRouteRearrange(false)
    setRouteStep(0)
    setConfigCollapsed(true)
    setMissionsCollapsed(true)
  }

  function toggleRouteDone(index: number) {
    const group = routeGroups[index]
    if (!group) return
    const keys = group.actions.map((_, actionIndex) => actionMarkKey(index, actionIndex))
    setDoneActions((prev) => {
      const all = keys.length > 0 && keys.every((key) => prev.has(key))
      const next = new Set(prev)
      for (const key of keys) {
        if (all) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  function toggleRouteKind(index: number, kind: 'pickup' | 'dropoff') {
    const group = routeGroups[index]
    if (!group) return
    const keys = group.actions
      .map((action, actionIndex) => ({ action, actionIndex }))
      .filter(({ action }) => action.kind === kind)
      .map(({ actionIndex }) => actionMarkKey(index, actionIndex))
    setDoneActions((prev) => {
      const all = keys.length > 0 && keys.every((key) => prev.has(key))
      const next = new Set(prev)
      for (const key of keys) {
        if (all) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  function toggleRouteAction(groupIndex: number, actionIndex: number) {
    if (!routeGroups[groupIndex]?.actions[actionIndex]) return
    const key = actionMarkKey(groupIndex, actionIndex)
    setDoneActions((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function finishCalculateRest(currentStep: number, fromLocationId?: string) {
    if (!route || !startId) return
    const groups = groupRouteByLocation(route.stops)
    const doneIdx = followingDoneIndices(doneGroups, groups.length, currentStep)
    if (doneIdx.length <= 0 || doneIdx.length >= groups.length) return
    const orderedIdx = fromLocationId
      ? [
          ...doneIdx.filter((i) => groups[i]?.locationId !== fromLocationId),
          ...doneIdx.filter((i) => groups[i]?.locationId === fromLocationId),
        ]
      : doneIdx
    const movedHere = orderedIdx.some((idx, i) => idx !== doneIdx[i])
    const contiguous = !movedHere && doneIdx.every((n, i) => n === i)
    let prefix = orderedIdx.flatMap((i) => groups[i].actions)
    if (movedHere) prefix = prefix.map((stop) => ({ ...stop, trip: 0 }))
    const resequenced = contiguous
      ? null
      : resequenceRouteStops(prefix, startId, capacityScu)
    if (resequenced) prefix = resequenced
    const fromId = fromLocationId ?? prefix[prefix.length - 1]?.locationId
    if (!fromId) return
    const ready = repairMissionLocations(missions)
    if (ready !== missions) setMissions(ready)
    const next = optimizeRouteFollowing(
      ready.filter(isMissionEnabled),
      capacityScu,
      prefix,
      fromId,
      { trustCargoAfter: contiguous || resequenced != null },
    )
    if (!next) return
    setRoute(next)
    const doneCount = groupRouteByLocation(prefix).length
    const marks = new Set<number>()
    for (let i = 0; i < doneCount; i++) marks.add(i)
    setDoneActions(actionKeysForGroups(groupRouteByLocation(next.stops), marks))
    const restGroups = groupRouteByLocation(next.stops)
    setRouteStep(Math.max(0, Math.min(doneCount - 1, restGroups.length - 1)))
    setRestHere(null)
  }

  function calculateRest(currentStep: number) {
    if (!route || !startId) return
    const groups = groupRouteByLocation(route.stops)
    const doneIdx = followingDoneIndices(doneGroups, groups.length, currentStep)
    if (doneIdx.length <= 0 || doneIdx.length >= groups.length) return
    const doneNotBefore = doneIdx.filter((i) => i > currentStep)
    if (doneNotBefore.length) {
      const options: { locationId: string; name: string }[] = []
      const seen = new Set<string>()
      for (const i of doneIdx) {
        const group = groups[i]
        if (!group || seen.has(group.locationId)) continue
        seen.add(group.locationId)
        options.push({ locationId: group.locationId, name: group.locationName })
      }
      if (!options.length) return
      setRestHere({
        currentStep,
        options,
        selectedId: options[options.length - 1].locationId,
      })
      return
    }
    finishCalculateRest(currentStep)
  }

  function moveRemainingGroup(index: number, delta: -1 | 1) {
    if (!route || !startId) return
    const doneCount = leadingDoneCount(doneGroups)
    const next = moveRouteGroup(route, startId, doneCount, index, delta)
    if (!next) return
    setRoute(next)
    setDoneActions((prev) =>
      remapActionMarks(prev, (i) => {
        if (i < doneCount) return i
        if (i === index) return index + delta
        if (i === index + delta) return index
        return i
      }),
    )
  }

  function resetOcrFileInput() {
    if (fileRef.current) fileRef.current.value = ''
  }

  function revokePendingItems(
    pending: typeof ocrPending,
    keepUrl?: string | null,
  ) {
    if (!pending) return
    for (const item of pending.items) {
      if (item.imageUrl && item.imageUrl !== keepUrl) {
        URL.revokeObjectURL(item.imageUrl)
      }
    }
  }

  function clearOcrPending() {
    lastOcrFillSig.current = ''
    ocrFilledOnce.current = false
    revokePendingItems(ocrPending)
    setOcrPending(null)
    resetOcrFileInput()
  }

  function dismissModal() {
    ocrCancelRef.current = true
    clearOcrPending()
    setPasteOpen(false)
    setOcrStatus('')
    setModalStep(null)
    setEditingMissionId(null)
  }

  function codeMissions(
    found: Mission[],
    opts?: { applyToMissionId?: string | null; cursor?: Mission[] },
  ): Mission[] {
    const applyToMissionId = opts?.applyToMissionId ?? null
    const existing = applyToMissionId
      ? missions.find((m) => m.id === applyToMissionId)
      : undefined
    let cursor = [...(opts?.cursor ?? missions)]
    return found.map((m) => {
      if (existing) {
        return { ...m, id: existing.id, code: existing.code }
      }
      const code = nextMissionCode(cursor)
      const next = { ...m, code }
      cursor = [...cursor, next]
      return next
    })
  }

  function openOcrBatch(
    items: OcrBatchItem[],
    opts?: {
      applyToMissionId?: string | null
      keepUrls?: boolean
      batchTotal?: number
      batchDone?: number
    },
  ) {
    if (!opts?.keepUrls) revokePendingItems(ocrPending)
    const applyToMissionId = opts?.applyToMissionId ?? null
    const batchTotal = opts?.batchTotal ?? items.length
    const batchDone = opts?.batchDone ?? items.length
    lastOcrFillSig.current = ''
    ocrFilledOnce.current = false
    setOcrPending({ items, index: 0, applyToMissionId, batchTotal, batchDone })
    if (applyToMissionId) {
      setEditingMissionId(applyToMissionId)
      setModalStep('edit')
    } else {
      setModalStep('add')
    }
    const n = items.reduce((s, it) => s + it.missions.length, 0)
    setOcrStatus(
      n
        ? applyToMissionId
          ? 'Scan filled into form — save when ready'
          : items.length > 1
            ? `Filled from image 1 · ${items.length} ready`
            : 'Scan filled into form'
        : 'No missions parsed',
    )
  }

  async function runOcr(
    file: File | Blob,
    opts?: {
      reuseImageUrl?: string | null
      applyToMissionId?: string | null
      /** Drop onto existing preview — swap current batch item’s image. */
      replaceCurrent?: boolean
    },
  ) {
    if (lockPlanRef.current) return
    ocrCancelRef.current = false
    setOcrBusy(true)
    setOcrProgress(0)
    setOcrStatus('Starting OCR…')
    const replaceCurrent = Boolean(opts?.replaceCurrent && ocrPending?.items.length)
    const reuse = replaceCurrent ? null : opts?.reuseImageUrl
    const prevUrl = replaceCurrent
      ? (ocrPending!.items[ocrPending!.index]?.imageUrl ?? null)
      : null
    const imageUrl = reuse ?? URL.createObjectURL(file)
    const updateInPlace = Boolean(reuse || replaceCurrent)
    const applyToMissionId =
      opts?.applyToMissionId !== undefined
        ? opts.applyToMissionId
        : (ocrPending?.applyToMissionId ?? null)
    if (applyToMissionId) {
      setEditingMissionId(applyToMissionId)
      setModalStep('edit')
    } else {
      setModalStep('add')
    }

    if (!updateInPlace) {
      setOcrPending({
        items: [],
        index: 0,
        applyToMissionId,
        batchTotal: 1,
        batchDone: 0,
      })
    } else if (replaceCurrent) {
      setOcrPending((prev) => {
        if (!prev?.items.length) return prev
        const idx = prev.index
        return {
          ...prev,
          items: prev.items.map((it, i) =>
            i === idx ? { ...it, imageUrl, source: file } : it,
          ),
        }
      })
      if (prevUrl) URL.revokeObjectURL(prevUrl)
    }

    try {
      const { text, missions: found, regions } = await readMissionImage(file, (p) => {
        if (ocrCancelRef.current) return
        setOcrStatus(p.status)
        setOcrProgress(p.progress)
      })
      if (ocrCancelRef.current) {
        if (!updateInPlace) URL.revokeObjectURL(imageUrl)
        return
      }
      // Rescan / replace current batch item in place
      if (updateInPlace) {
        const coded = codeMissions(found, { applyToMissionId })
        lastOcrFillSig.current = ''
        setOcrPending((prev) => {
          if (!prev?.items.length) return prev
          const idx = prev.index
          return {
            ...prev,
            items: prev.items.map((it, i) =>
              i === idx
                ? {
                    missions: coded,
                    regions,
                    text,
                    imageUrl,
                    source: file,
                  }
                : it,
            ),
          }
        })
        setOcrStatus(found.length ? 'Scan filled into form' : 'No missions parsed')
        return
      }

      openOcrBatch(
        [
          {
            missions: codeMissions(found, { applyToMissionId }),
            regions,
            text,
            imageUrl,
            source: file,
          },
        ],
        { applyToMissionId, batchTotal: 1, batchDone: 1 },
      )
    } catch (err) {
      if (!updateInPlace) URL.revokeObjectURL(imageUrl)
      setOcrStatus(err instanceof Error ? err.message : 'OCR failed')
    } finally {
      setOcrBusy(false)
    }
  }

  /** Drop onto the current screenshot — update that slot only. */
  function replaceOcrCurrentImage(files: File[]) {
    const images = files.filter(
      (f) =>
        f.type.startsWith('image/') ||
        /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name),
    )
    if (!images.length || ocrBusy) return
    if (ocrPending?.items.length) {
      void runOcr(images[0], {
        replaceCurrent: true,
        applyToMissionId: ocrPending.applyToMissionId,
      })
      return
    }
    void runOcrFiles(images, {
      applyToMissionId:
        modalStep === 'edit' && editingMissionId ? editingMissionId : null,
    })
  }

  /** Browse / drop — fill the form as each image finishes (streamed). */
  async function runOcrFiles(
    files: Array<File | Blob>,
    opts?: { applyToMissionId?: string | null },
  ) {
    if (lockPlanRef.current) return
    const images = files.filter((f) => {
      if (f instanceof File) {
        return f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)
      }
      return true
    })
    if (!images.length) return

    if (opts?.applyToMissionId) {
      setEditingMissionId(opts.applyToMissionId)
      await runOcr(images[0], { applyToMissionId: opts.applyToMissionId })
      return
    }
    if (images.length === 1) {
      await runOcr(images[0])
      return
    }

    ocrCancelRef.current = false
    setOcrBusy(true)
    setOcrProgress(0)
    setModalStep('add')
    lastOcrFillSig.current = ''
    ocrFilledOnce.current = false
    setOcrPending({
      items: [],
      index: 0,
      applyToMissionId: null,
      batchTotal: images.length,
      batchDone: 0,
    })

    let cursor = [...missions]
    let parsedAny = false

    try {
      for (let i = 0; i < images.length; i++) {
        if (ocrCancelRef.current) break
        const file = images[i]
        const url = URL.createObjectURL(file)
        setOcrStatus(`Scanning ${i + 1} of ${images.length}…`)
        setOcrProgress(i / images.length)
        const { text, missions: found, regions } = await readMissionImage(file, (p) => {
          if (ocrCancelRef.current) return
          setOcrStatus(`Scanning ${i + 1} of ${images.length}… ${p.status}`)
          setOcrProgress((i + p.progress) / images.length)
        })
        if (ocrCancelRef.current) {
          URL.revokeObjectURL(url)
          break
        }
        const coded = codeMissions(found, { cursor })
        cursor = [...cursor, ...coded]
        if (coded[0]) parsedAny = true
        setOcrPending((prev) => {
          if (!prev || ocrCancelRef.current) {
            URL.revokeObjectURL(url)
            return prev
          }
          const items = [
            ...prev.items,
            { missions: coded, regions, text, imageUrl: url, source: file },
          ]
          return {
            ...prev,
            items,
            batchDone: i + 1,
            index: prev.items.length === 0 ? 0 : Math.min(prev.index, items.length - 1),
          }
        })
        setOcrProgress((i + 1) / images.length)
      }
      if (!ocrCancelRef.current) {
        setOcrStatus(
          parsedAny
            ? `Form filled · ${images.length} image${images.length === 1 ? '' : 's'} ready`
            : 'No missions parsed',
        )
      }
    } catch (err) {
      setOcrStatus(err instanceof Error ? err.message : 'OCR failed')
    } finally {
      setOcrBusy(false)
    }
  }

  runOcrFilesRef.current = runOcrFiles

  function rescanOcrPending() {
    if (!ocrPending || ocrBusy) return
    const item = ocrPending.items[ocrPending.index]
    if (!item?.source) return
    void runOcr(item.source, {
      reuseImageUrl: item.imageUrl,
      applyToMissionId: ocrPending.applyToMissionId,
    })
  }

  function importPastedText() {
    const found = parseMissionText(pasteText)
    const coded = codeMissions(found)
    openOcrBatch([
      {
        missions: coded,
        regions: {
          title: pasteText,
          reward: '',
          giver: '',
          info: '',
          objectives: pasteText,
          full: pasteText,
        },
        text: pasteText,
        imageUrl: null,
        source: null,
      },
    ])
    setPasteOpen(false)
    setPasteText('')
  }

  function addOcrMissions(list: Mission[]) {
    if (!list.length) return
    setMissions((prev) => [...prev, ...list])
    setMissionsInitialized(true)
    clearPlannedRoute()
  }

  function addOcrAll() {
    if (!ocrPending) return
    const objectives = (draft.objectives ?? []).map((o) => createEmptyObjective(o))
    if (draftHasCargo() && objectivesHaveErrors(objectives)) return
    ocrCancelRef.current = true
    const pending = pendingWithCurrentDraft(ocrPending)
    const all = pending.items.flatMap((it) => it.missions)
    addOcrMissions(all)
    clearOcrPending()
    setOcrStatus(all.length ? `Added ${all.length} mission${all.length === 1 ? '' : 's'}` : '')
    setModalStep(null)
  }

  function selectOcrIndex(index: number) {
    if (!ocrPending || index < 0 || index >= ocrPending.items.length) return
    if (index === ocrPending.index) return
    const pending = pendingWithCurrentDraft(ocrPending)
    // Index change triggers the fill effect; flush so the form key/draft update together
    flushSync(() => {
      setOcrPending({ ...pending, index })
    })
  }

  const ocrFillMission =
    ocrPending?.applyToMissionId && ocrPending.items[ocrPending.index]
      ? (ocrPending.items[ocrPending.index].missions[0] ?? null)
      : null

  const typeLabel = haulTypeLabel

  if (shareGate === 'wait') {
    return (
      <div className="app boot">
        <div className="atmosphere" aria-hidden />
        <p className="brand">SC Hauling Companion</p>
        <p className="hint">Opening shared run…</p>
      </div>
    )
  }

  if (catalog.loading && !catalog.loadedAt) {
    return (
      <div className="app boot">
        <div className="atmosphere" aria-hidden />
        <p className="brand">SC Hauling Companion</p>
        <p className="hint">Loading ships, locations & mission names from UEX…</p>
      </div>
    )
  }

  if (catalog.error && !catalog.loadedAt) {
    return (
      <div className="app boot">
        <div className="atmosphere" aria-hidden />
        <p className="brand">SC Hauling Companion</p>
        <p className="hint">Failed to load catalog: {catalog.error}</p>
        <button type="button" className="primary" onClick={() => void catalog.reload()}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="atmosphere" aria-hidden />

      <header className="topbar">
        <div className="brand-block">
          <p className="brand">SC Hauling Companion</p>
          <p className="tagline">
            Live UEX ships & locations · every stop routed · crate size per mission
          </p>
        </div>
        <div className="topbar-actions">
          <button type="button" className="ghost" onClick={() => void catalog.reload()}>
            Refresh data
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!missions.length}
            title="Share an all-edit link, a loads-and-stops link, and a view-only link"
            onClick={openShare}
          >
            Share
          </button>
        <button
          type="button"
            className="primary calc-btn"
            onClick={runOptimize}
            disabled={lockPlan || !activeMissions.length || !startId}
        >
            Calculate optimal route
        </button>
        </div>
      </header>

      <main className="shell">
        <aside className="sidebar">
          <section className={`panel collapsible${configCollapsed ? ' collapsed' : ''}`}>
            <div
              className="panel-head collapse-bar"
              role="button"
              tabIndex={0}
              aria-expanded={!configCollapsed}
              aria-label={configCollapsed ? 'Expand configuration' : 'Minimize configuration'}
              onClick={() => setConfigCollapsed((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setConfigCollapsed((v) => !v)
                }
              }}
            >
              <h2 className="collapse-title">
                {configCollapsed
                  ? (() => {
                      const start = getLocation(startId)?.shortName ?? '—'
                      if (capacityMode === 'ship') {
                        const ship = catalog.ships.find((s) => s.id === shipId)
                        const shipPart = ship
                          ? `${ship.name} · ${ship.cargoScu} SCU`
                          : formatHoldCapacity(capacityScu)
                        return `Config · ${shipPart} · ${start}`
                      }
                      return `Config · ${formatHoldCapacity(capacityScu)} · ${start}`
                    })()
                  : 'Run configuration'}
              </h2>
              <span className="collapse-arrow" aria-hidden>
                {configCollapsed ? '▾' : '▴'}
              </span>
            </div>

            {!configCollapsed && (
              <fieldset className={`bare-fieldset${lockPlan ? ' plan-locked' : ''}`} disabled={lockPlan}>
                <div className="mode-toggle" role="group" aria-label="Capacity source">
                  <button
                    type="button"
                    className={capacityMode === 'ship' ? 'active' : ''}
                    onClick={() => setCapacityMode('ship')}
                  >
                    Ship
                  </button>
                  <button
                    type="button"
                    className={capacityMode === 'custom' ? 'active' : ''}
                    onClick={() => setCapacityMode('custom')}
                  >
                    Max SCU
                  </button>
                </div>

                {capacityMode === 'ship' ? (
                  <ShipPicker
                    ships={catalog.ships}
                    value={shipId}
                    onChange={setShipId}
                  />
                ) : (
                  <label className="field">
                    <span>Max cargo capacity (SCU)</span>
                    <div className="commodity-picker-bar">
                      <div className="field-input-wrap">
                        <input
                          type="number"
                          min={0}
                          className="commodity-picker-search"
                          value={customScu}
                          onChange={(e) => setCustomScu(Number(e.target.value))}
                        />
                        <FieldClearButton
                          visible={customScu !== 0}
                          label="Clear capacity"
                          onClear={() => setCustomScu(0)}
                        />
                      </div>
                    </div>
                  </label>
                )}

                <StartLocationPicker
                  locations={catalog.locations}
                  value={startId}
                  onChange={setStartId}
                />

                <div className="capacity-chip">
                  Hold <strong>{formatHoldCapacity(capacityScu)}</strong>
                  <span className="dot" />
                  {getLocation(startId)?.shortName ?? '—'}
                </div>
              </fieldset>
            )}
          </section>

          <section className={`panel collapsible${missionsCollapsed ? ' collapsed' : ''}${lockPlan ? ' plan-locked' : ''}`}>
            <div
              className="panel-head collapse-bar"
              role="button"
              tabIndex={0}
              aria-expanded={!missionsCollapsed}
              aria-label={missionsCollapsed ? 'Expand missions' : 'Minimize missions'}
              onClick={() => setMissionsCollapsed((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setMissionsCollapsed((v) => !v)
                }
              }}
            >
              <h2 className="collapse-title">
                {`Missions · ${activeMissions.length}/${missions.length} · ${activeScu} SCU`}
              </h2>
              <div
                className="panel-actions icon-actions"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="primary icon-btn add-btn"
                  disabled={lockPlan}
                  onClick={() => {
                    setEditingMissionId(null)
                    setDraft((d) => ({ ...d, code: nextMissionCode(missions) }))
                    setModalStep('add')
                  }}
                  title="Add mission"
                  aria-label="Add mission"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                    <path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z" />
                </svg>
                </button>
                <button
                  type="button"
                  className={`ghost icon-btn${missionsRearrangeMode ? ' active' : ''}`}
                  disabled={lockPlan || missions.length < 2}
                  onClick={() => setMissionsRearrangeMode((v) => !v)}
                  title={
                    missionsRearrangeMode
                      ? 'Done rearranging'
                      : 'Rearrange missions'
                  }
                  aria-label={
                    missionsRearrangeMode
                      ? 'Done rearranging'
                      : 'Rearrange missions'
                  }
                  aria-pressed={missionsRearrangeMode}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                    <path
                      fill="currentColor"
                      d="M4 7h16v2H4V7zm0 4h16v2H4v-2zm0 4h10v2H4v-2z"
                    />
                  </svg>
                </button>
                {missionsRearrangeMode ? (
                  <button
                    type="button"
                    className="ghost icon-btn"
                    disabled={lockPlan || missions.length < 2}
                    onClick={sortMissionsByCodeAction}
                    title="Sort by code"
                    aria-label="Sort by code"
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                      <path
                        fill="currentColor"
                        d="M7 4h2v12h3l-4 5-4-5h3V4zm8 15h2V7h3l-4-5-4 5h3v12z"
                      />
                    </svg>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ghost icon-btn"
                  disabled={lockPlan || !undoStack.length}
                  onClick={undoMissionChange}
                  title={
                    undoStack.length
                      ? `Undo (${undoStack.length}/${UNDO_LIMIT})`
                      : 'Nothing to undo'
                  }
                  aria-label="Undo"
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                    <path
                      fill="currentColor"
                      d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L3 8v6h6l-2.25-2.25A7.96 7.96 0 0 1 12.5 10c3.04 0 5.64 1.7 6.94 4.2l1.8-.9C19.6 10.2 16.3 8 12.5 8z"
                    />
                </svg>
                </button>
                <button
                  type="button"
                  className="ghost icon-btn"
                  disabled={lockPlan || !redoStack.length}
                  onClick={redoMissionChange}
                  title={
                    redoStack.length
                      ? `Redo (${redoStack.length}/${UNDO_LIMIT})`
                      : 'Nothing to redo'
                  }
                  aria-label="Redo"
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                    <path
                      fill="currentColor"
                      d="M11.5 8c2.65 0 5.05 1 6.9 2.6L21 8v6h-6l2.25-2.25A7.96 7.96 0 0 0 11.5 10c-3.04 0-5.64 1.7-6.94 4.2l-1.8-.9C4.4 10.2 7.7 8 11.5 8z"
                    />
                </svg>
                </button>
                <button
                  type="button"
                  className="ghost icon-btn danger"
                  onClick={requestPurgeMissions}
                  disabled={lockPlan || !missions.length}
                  title="Purge all missions"
                  aria-label="Purge all missions"
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                    <path
                      fill="currentColor"
                      d="M6 7h12v2H6V7zm2 3h2v8H8v-8zm3 0h2v8h-2v-8zm3 0h2v8h-2v-8zM9 4h6l1 1h4v2H4V5h4l1-1z"
                    />
                </svg>
                </button>
              </div>
              <span className="collapse-arrow" aria-hidden>
                {missionsCollapsed ? '▾' : '▴'}
              </span>
            </div>

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={lockPlan}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                e.target.value = ''
                if (files.length) void runOcrFiles(files)
              }}
            />

            {!missionsCollapsed && (
              <div className="mission-list-wrap">
                <div
                  ref={missionActionProbeRef}
                  className="mission-action-fit-probe"
                  aria-hidden
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className="ghost mission-action-probe-btn"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                      <path
                        fill="currentColor"
                        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
                      />
                    </svg>
                    <span>Edit</span>
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    className="ghost danger mission-action-probe-btn"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                      <path
                        fill="currentColor"
                        d="M6 7h12v2H6V7zm2 3h2v8H8v-8zm3 0h2v8h-2v-8zm3 0h2v8h-2v-8zM9 4h6l1 1h4v2H4V5h4l1-1z"
                      />
                    </svg>
                    <span>Remove</span>
                  </button>
                </div>
              <ul
                ref={missionListRef}
                className={`mission-list${missionActionText ? ' mission-actions-use-text' : ''}`}
              >
                {missions.length === 0 && (
                  <li className="empty">No missions yet. Click Add to create one.</li>
                )}
                {missions.map((m, index) => {
                  const on = isMissionEnabled(m)
                  const finished = finishedMissionIds.has(m.id)
                  return (
                  <li
                    key={m.id}
                    className={`mission-row selected mission-row-compact${on ? '' : ' mission-row-off'}${finished ? ' mission-row-done' : ''}`}
                  >
                    <label className="mission-enable" title={on ? 'On for routing' : 'Off for routing'}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={lockPlan}
                        onChange={() => toggleMissionEnabled(m.id)}
                        aria-label={`${on ? 'Disable' : 'Enable'} mission ${m.code}`}
                      />
                    </label>
                    <div className="mission-main">
                      <div className="mission-title-row">
                        <span className="mission-code">{m.code}</span>
                        {finished && (
                          <span className="tag mission-done-tag">Completed</span>
                        )}
                        <AutoScrollName text={m.name} />
                      </div>
                      <MissionPriorityTags
                        mission={m}
                        typeLabel={typeLabel}
                        sharedKeys={sharedMissionTagKeys}
                        onLayout={onMissionTagLayout}
                      />
                      <p className="stops-line stops-compact">
                        <span className="lbl">In</span>
                        <StopLocationList stops={m.pickups} getName={locationLabel} />
                      </p>
                      <p className="stops-line stops-compact">
                        <span className="lbl">Out</span>
                        <StopLocationList
                          stops={m.dropoffs}
                          getName={locationLabel}
                        />
                      </p>
                      {m.objectives.some((o) => o.loadNote?.trim()) && (
                        <p className="mission-load-note">
                          Load:{' '}
                          {m.objectives
                            .map((o) => o.loadNote?.trim())
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                    </div>
                    <div
                      className={`mission-actions${missionsRearrangeMode ? ' rearranging' : ''}`}
                    >
                      {missionsRearrangeMode ? (
                        <>
                          <button
                            type="button"
                            className="ghost icon-btn"
                            disabled={lockPlan || index === 0}
                            onClick={() => moveMission(m.id, -1)}
                            title="Move up"
                            aria-label={`Move ${m.code} up`}
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                              <path fill="currentColor" d="M7 14l5-5 5 5H7z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="ghost icon-btn"
                            disabled={lockPlan || index >= missions.length - 1}
                            onClick={() => moveMission(m.id, 1)}
                            title="Move down"
                            aria-label={`Move ${m.code} down`}
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                              <path fill="currentColor" d="M7 10l5 5 5-5H7z" />
                            </svg>
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={`ghost mission-action-btn${lockPlan ? ' is-locked' : ''}`}
                            disabled={lockPlan}
                            onClick={() => {
                              setEditingMissionId(m.id)
                              setModalStep('edit')
                            }}
                            title={lockPlan ? 'Locked' : 'Edit'}
                            aria-label={lockPlan ? `Edit ${m.code} is locked` : `Edit ${m.code}`}
                          >
                            <span className="mission-action-glyph">
                              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                                <path
                                  fill="currentColor"
                                  d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
                                />
                              </svg>
                              {lockPlan && <LockIcon />}
                            </span>
                            <span className="mission-action-label">Edit</span>
                          </button>
                          <button
                            type="button"
                            className={`ghost danger mission-action-btn${lockPlan ? ' is-locked' : ''}`}
                            disabled={lockPlan}
                            onClick={() => removeMission(m.id)}
                            title={lockPlan ? 'Locked' : 'Remove'}
                            aria-label={lockPlan ? `Remove ${m.code} is locked` : `Remove ${m.code}`}
                          >
                            <span className="mission-action-glyph">
                              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                                <path
                                  fill="currentColor"
                                  d="M6 7h12v2H6V7zm2 3h2v8H8v-8zm3 0h2v8h-2v-8zm3 0h2v8h-2v-8zM9 4h6l1 1h4v2H4V5h4l1-1z"
                                />
                              </svg>
                              {lockPlan && <LockIcon />}
                            </span>
                            <span className="mission-action-label">Remove</span>
                          </button>
                        </>
                      )}
                    </div>
            </li>
                  )
                })}
          </ul>
              </div>
            )}
          </section>
        </aside>

        <section className={`route-panel panel${viewOnly ? ' plan-locked' : ''}`}>
          <div className="panel-head">
            <h2>Route summary</h2>
            {liveRole && (
              <span
                className="method-tag"
                title={
                  liveRole === 'edit'
                    ? 'This page can change the whole shared run'
                    : liveRole === 'run'
                      ? 'This page can update loads, unloads, and the remaining stops'
                      : 'This link follows the route and cannot change it'
                }
              >
                {liveConn !== 'live'
                  ? 'Connecting'
                  : liveRole === 'view'
                    ? 'View only'
                    : liveRole === 'run'
                      ? 'Loads & stops'
                      : 'All edit'}
              </span>
            )}
            {route && <span className="method-tag">{route.method}</span>}
          </div>

          {!route && liveRole === 'view' && (
            <p className="hint">
              {liveConn === 'live'
                ? 'Waiting for the shared route. It will show up here on its own.'
                : 'Connecting to the live route…'}
            </p>
          )}

          {!route && liveRole !== 'view' && (
            <p className="hint">
              Same locations are grouped. Each pickup lists individual crates. Amend
              actual SCU on site to re-spread remaining cargo across following pickups
              on that mission.
            </p>
          )}

          {route && (
            <RouteSummary
              route={route}
              missions={missions}
              startId={startId}
              capacityScu={capacityScu}
              doneGroups={doneGroups}
              doneActions={doneActions}
              rearrange={routeRearrange}
              step={routeStep}
              onStepChange={setRouteStep}
              onToggleDone={toggleRouteDone}
              onToggleKind={toggleRouteKind}
              onToggleAction={toggleRouteAction}
              onCalculateRest={calculateRest}
              onToggleRearrange={() => setRouteRearrange((v) => !v)}
              onMoveGroup={moveRemainingGroup}
              onAmendPickup={amendPickup}
              onLoadNote={setCargoLoadNote}
              readOnly={viewOnly}
              limited={liveRole === 'run'}
            />
          )}
        </section>
      </main>

      <footer className="foot">
        Ships & commodities from{' '}
        <a href="https://uexcorp.space/" target="_blank" rel="noreferrer">
          UEX API
        </a>
        ; locations from UEX terminals + scunpacked coords (via SuperCargo data). Mission
        titles use in-game haul rank/type patterns. Unofficial community tool.
      </footer>

      {shareLinks && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setShareLinks(null)}
        >
          <div
            className="modal panel confirm-modal share-modal"
            role="dialog"
            aria-labelledby="share-title"
            aria-describedby="share-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-head">
              <h2 id="share-title">Share links</h2>
            </div>
            <p id="share-desc" className="hint">
              {shareLinks.edit
                ? 'All edit can change the whole run. Loads and stops can update cargo and the remaining stops, not the missions or ship. View only follows along. They stay current while an edit page is open.'
                : shareLinks.run
                  ? 'Loads and stops can update cargo and the remaining stops. View only follows along and cannot change them.'
                  : 'This link follows the route and cannot change it.'}
            </p>
            {shareLinks.edit && (
              <label className="field share-link-field">
                <span>All edit</span>
                <div className="share-link-row">
                  <input
                    readOnly
                    value={shareLinks.edit}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button type="button" className="ghost" onClick={() => void copyShareField('edit')}>
                    {copiedLink === 'edit' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </label>
            )}
            {shareLinks.run && (
              <label className="field share-link-field">
                <span>Loads and stops</span>
                <div className="share-link-row">
                  <input
                    readOnly
                    value={shareLinks.run}
                    autoFocus={!shareLinks.edit}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button type="button" className="ghost" onClick={() => void copyShareField('run')}>
                    {copiedLink === 'run' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </label>
            )}
            <label className="field share-link-field">
              <span className="locked-label">
                <LockIcon />
                View only
              </span>
              <div className="share-link-row">
                <input
                  readOnly
                  value={shareLinks.view || 'Waiting for the live connection…'}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  className="ghost"
                  disabled={!shareLinks.view}
                  onClick={() => void copyShareField('view')}
                >
                  {copiedLink === 'view' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </label>
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => setShareLinks(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {purgeConfirmOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setPurgeConfirmOpen(false)}
        >
          <div
            className="modal panel confirm-modal"
            role="alertdialog"
            aria-labelledby="purge-confirm-title"
            aria-describedby="purge-confirm-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-head">
              <h2 id="purge-confirm-title">Purge missions?</h2>
            </div>
            <p id="purge-confirm-desc" className="hint">
              Remove all {missions.length} mission{missions.length === 1 ? '' : 's'}? This
              can be undone.
            </p>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setPurgeConfirmOpen(false)}>
                Cancel
              </button>
              <button type="button" className="primary danger" onClick={confirmPurgeMissions}>
                Purge all
              </button>
            </div>
          </div>
        </div>
      )}

      {restHere && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setRestHere(null)}
        >
          <div
            className="modal panel confirm-modal"
            role="dialog"
            aria-labelledby="rest-here-title"
            aria-describedby="rest-here-desc"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-head">
              <h2 id="rest-here-title">Where are you now?</h2>
            </div>
            <p id="rest-here-desc" className="hint">
              A done stop is not before the current step. Pick the done location you
              are at. The rest of the route starts there.
            </p>
            <div className="rest-here-options">
              {restHere.options.map((option) => (
                <label key={option.locationId}>
                  <input
                    type="radio"
                    name="rest-here"
                    value={option.locationId}
                    checked={restHere.selectedId === option.locationId}
                    onChange={() =>
                      setRestHere((prev) =>
                        prev ? { ...prev, selectedId: option.locationId } : prev,
                      )
                    }
                  />
                  <span>{option.name}</span>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => setRestHere(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => finishCalculateRest(restHere.currentStep, restHere.selectedId)}
              >
                Calculate rest
              </button>
            </div>
          </div>
        </div>
      )}

      {modalStep && (
        <MissionModal
          step={modalStep}
          mission={editingMission}
          missions={missions}
          locations={getAllLocations()}
          commodities={catalog.commodities}
          givers={catalog.givers}
          missionNames={catalog.missionNames}
          draftHaul={draftHaul}
          draft={draft}
          onDraftHaul={setDraftHaul}
          onDraft={setDraft}
          onAddManual={addMission}
          onSaveEdit={saveMission}
          ocrFormKey={ocrFormKey}
          ocrItems={ocrPending?.items ?? []}
          ocrIndex={ocrPending?.index ?? 0}
          onOcrIndex={selectOcrIndex}
          ocrFillMission={ocrFillMission}
          ocrBusy={ocrBusy}
          ocrProgress={ocrProgress}
          ocrStatus={ocrStatus}
          batchTotal={ocrPending?.batchTotal ?? 0}
          batchDone={ocrPending?.batchDone ?? 0}
          pasteOpen={pasteOpen}
          pasteText={pasteText}
          onPasteOpen={setPasteOpen}
          onPasteText={setPasteText}
          onImportPaste={importPastedText}
          onBrowse={() => fileRef.current?.click()}
          onDropFiles={(files) => {
            void runOcrFiles(files, {
              applyToMissionId:
                modalStep === 'edit' && editingMissionId ? editingMissionId : null,
            })
          }}
          onReplaceImage={replaceOcrCurrentImage}
          onRescan={rescanOcrPending}
          onAddAll={addOcrAll}
          onAddDemo={fillDraftFromDemo}
          onClose={dismissModal}
        />
      )}
    </div>
  )
}
