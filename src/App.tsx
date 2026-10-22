import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  MissionModal,
  type MissionModalStep,
  type OcrBatchItem,
} from './components/MissionModal'
import { RouteSummary } from './components/RouteSummary'
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
import { buildAutoMissionName } from './lib/haulTypes'
import {
  createEmptyObjective,
  legacyMissionToObjectives,
  missionCommodityLabel,
  missionTotalScu,
  objectiveRouteParts,
  objectivesHaveErrors,
} from './lib/objectives'
import { parseMissionText, readMissionImage } from './lib/ocr'
import { formatAuec, formatHoldCapacity, optimizeRoute } from './lib/optimizer'
import {
  DEFAULT_MAX_UNIT_SCU,
  amendPickupActual,
  clampMissionCode,
  createMission,
  formatStopSummary,
  nextDemoMissionCode,
  nextMissionCode,
  normalizeCrateSize,
} from './lib/spread'
import {
  getAllLocations,
  getLocation,
  locationLabel,
} from './store/catalog'
import type { HaulType, Mission, OptimizedRoute } from './types'
import './App.css'

const cached = loadAppCache()

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
  const [route, setRoute] = useState<OptimizedRoute | null>(null)
  const [configCollapsed, setConfigCollapsed] = useState(false)
  const [missionsCollapsed, setMissionsCollapsed] = useState(false)
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false)
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
  const ocrCancelRef = useRef(false)
  const lastOcrFillSig = useRef('')
  const demoIndexRef = useRef(
    cached.missions.filter((m) => m.source === 'demo').length,
  )

  const capacityScu = useMemo(() => {
    if (capacityMode === 'custom') return Math.max(0, customScu)
    return catalog.ships.find((s) => s.id === shipId)?.cargoScu ?? 0
  }, [capacityMode, customScu, shipId, catalog.ships])


  // Persist all selectable choices
  useEffect(() => {
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
  ])

  // Fill missing selects once catalog arrives (keep cached values when still valid)
  useEffect(() => {
    if (!catalog.loadedAt) return

    const shipOk = Boolean(shipId && catalog.ships.some((s) => s.id === shipId))
    if (shipOk) {
      shipInitDone.current = true
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
  }, [catalog.loadedAt, catalog.ships, catalog.locations])

  const runOcrFilesRef = useRef<
    (files: Array<File | Blob>, opts?: { applyToMissionId?: string | null }) => Promise<void>
  >(async () => {})
  const ocrBusyRef = useRef(ocrBusy)
  ocrBusyRef.current = ocrBusy

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (ocrBusyRef.current) return
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
    setRoute(null)
  }

  function redoMissionChange() {
    if (!redoStack.length) return
    const restore = redoStack[redoStack.length - 1]
    setUndoStack((stack) => [...stack, cloneMissions(missions)].slice(-UNDO_LIMIT))
    setRedoStack((stack) => stack.slice(0, -1))
    setMissions(restore)
    setMissionsInitialized(true)
    setRoute(null)
  }

  function fillDraftFromMission(m: Mission | null | undefined) {
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
            : draft.code || nextMissionCode(missions),
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
    lastOcrFillSig.current = sig
    fillDraftFromMission(m)
  }, [modalStep, ocrPending])

  function addMission() {
    const scanned =
      ocrPending && !ocrPending.applyToMissionId
        ? ocrPending.items[ocrPending.index]?.missions[0]
        : undefined

    const draftObjectives =
      draft.objectives?.length > 0
        ? draft.objectives.map((o) => createEmptyObjective(o))
        : []
    const scannedObjectives = scanned
      ? legacyMissionToObjectives(scanned).map((o) => createEmptyObjective(o))
      : []

    // Prefer draft objectives when user edited; else OCR-parsed objectives
    const useDraftStops = draftObjectives.some(
      (o) => o.pickups.length > 0 && o.dropoffs.length > 0,
    )
    const objectives = useDraftStops
      ? draftObjectives
      : scannedObjectives.length
        ? scannedObjectives
        : draftObjectives

    if (objectivesHaveErrors(objectives)) return

    const route = objectiveRouteParts(objectives)
    const total = Math.max(
      1,
      missionTotalScu(objectives) ||
        Number(draft.totalScu) ||
        scanned?.totalScu ||
        1,
    )

    const isDemo =
      Boolean(draft.demo) || draft.name.trim().startsWith('(DEMO)')
    const code =
      clampMissionCode(draft.code) ||
      (isDemo ? nextDemoMissionCode(missions) : nextMissionCode(missions))
    setMissions((prev) => {
      const autoName = buildAutoMissionName({
        giver: draft.giver.trim() || scanned?.giver,
        rank: draft.rank.trim() || scanned?.rank,
        haulType: draftHaul,
        from: route.from,
        to: route.to,
        pickupCount: route.pickupCount,
        dropoffCount: route.dropoffCount,
        demo: isDemo,
      })
      const mission = createMission({
        code,
        name:
          draft.name.trim() ||
          scanned?.name ||
          autoName ||
          `Haul ${total} SCU → ${route.to}`,
        haulType: draftHaul,
        rank: draft.rank.trim() || scanned?.rank,
        giver: draft.giver.trim() || scanned?.giver,
        pickupIds: objectives.flatMap((o) => o.pickups.map((p) => p.locationId)),
        dropoffIds: objectives.flatMap((o) =>
          o.dropoffs.map((d) => d.locationId),
        ),
        totalScu: total,
        maxUnitScu: normalizeCrateSize(
          draft.maxUnitScu || scanned?.maxUnitScu || DEFAULT_MAX_UNIT_SCU,
        ),
        rewardAuec: Number(draft.rewardAuec) || scanned?.rewardAuec,
        commodity:
          missionCommodityLabel(objectives) ||
          draft.commodity.trim() ||
          scanned?.commodity,
        objectives,
        source: scanned ? 'ocr' : isDemo ? 'demo' : 'manual',
      })
      return [...prev, mission]
    })
    setMissionsInitialized(true)
    setRoute(null)
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

  function amendPickup(missionId: string, locationId: string, actualScu: number) {
    const next = missions.map((m) =>
      m.id === missionId ? amendPickupActual(m, locationId, actualScu) : m,
    )
    setMissions(next)
    if (startId) setRoute(optimizeRoute(next, startId, capacityScu))
  }

  function removeMission(id: string) {
    pushMissionUndo(missions)
    setMissions((m) => m.filter((x) => x.id !== id))
    setMissionsInitialized(true)
    setRoute(null)
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
    setRoute(null)
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
    }
  }

  function saveMission(updated: Mission) {
    setMissions((list) => list.map((m) => (m.id === updated.id ? updated : m)))
    setMissionsInitialized(true)
    setEditingMissionId(null)
    setModalStep(null)
    setRoute(null)
  }

  const editingMission = editingMissionId
    ? missions.find((m) => m.id === editingMissionId) ?? null
    : null

  function runOptimize() {
    if (!startId) return
    setRoute(optimizeRoute(missions, startId, capacityScu))
    setConfigCollapsed(true)
    setMissionsCollapsed(true)
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
    setRoute(null)
  }

  function addOcrAll() {
    if (!ocrPending) return
    ocrCancelRef.current = true
    const all = ocrPending.items.flatMap((it) => it.missions)
    addOcrMissions(all)
    clearOcrPending()
    setOcrStatus(all.length ? `Added ${all.length} mission${all.length === 1 ? '' : 's'}` : '')
    setModalStep(null)
  }

  function selectOcrIndex(index: number) {
    if (!ocrPending || index < 0 || index >= ocrPending.items.length) return
    if (index === ocrPending.index) return
    // Index change triggers the fill effect; flush so the form key/draft update together
    flushSync(() => {
      setOcrPending({ ...ocrPending, index })
    })
  }

  const ocrFillMission =
    ocrPending?.applyToMissionId && ocrPending.items[ocrPending.index]
      ? (ocrPending.items[ocrPending.index].missions[0] ?? null)
      : null

  const typeLabel = (t: HaulType) => t

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
            className="primary calc-btn"
            onClick={runOptimize}
            disabled={!missions.length || !startId}
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
              <>
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
              </>
            )}
          </section>

          <section className={`panel collapsible${missionsCollapsed ? ' collapsed' : ''}`}>
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
                {`Missions · ${missions.length} · ${missions.reduce((s, m) => s + m.totalScu, 0)} SCU`}
              </h2>
              <div
                className="panel-actions icon-actions"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="primary icon-btn add-btn"
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
                  className="ghost icon-btn"
                  disabled={!undoStack.length}
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
                  disabled={!redoStack.length}
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
                  disabled={!missions.length}
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
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                e.target.value = ''
                if (files.length) void runOcrFiles(files)
              }}
            />

            {!missionsCollapsed && (
              <ul className="mission-list">
                {missions.length === 0 && (
                  <li className="empty">No missions yet. Click Add to create one.</li>
                )}
                {missions.map((m) => {
                  const objs = legacyMissionToObjectives(m)
                  const commodityLabel =
                    missionCommodityLabel(objs) || m.commodity
                  return (
                  <li key={m.id} className="mission-row selected mission-row-compact">
                    <div className="mission-main">
                      <strong>
                        <span className="mission-code">{m.code}</span> {m.name}
                      </strong>
                      <p className="mission-meta">
                        {m.giver ? <span className="tag">{m.giver}</span> : null}
                        {m.rank ? <span className="tag">{m.rank}</span> : null}
                        <span className="tag">{typeLabel(m.haulType)}</span>
                        {missionTotalScu(objs) || m.totalScu} SCU
                        {commodityLabel ? ` ${commodityLabel}` : ''}
                        {m.rewardAuec != null ? ` · ${formatAuec(m.rewardAuec)}` : ''}
                        {` · crate ${m.maxUnitScu}`}
                        {objs.length > 1 ? ` · ${objs.length} objectives` : ''}
                      </p>
                      <p className="stops-line stops-compact">
                        <span className="lbl">In</span>{' '}
                        {formatStopSummary(m.pickups, locationLabel, m.maxUnitScu)}
                        <span className="stops-sep">·</span>
                        <span className="lbl">Out</span>{' '}
                        {formatStopSummary(m.dropoffs, locationLabel, m.maxUnitScu)}
                      </p>
                    </div>
                    <div className="mission-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setEditingMissionId(m.id)
                          setModalStep('edit')
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="ghost danger"
                        onClick={() => removeMission(m.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                  )
                })}
              </ul>
            )}
          </section>
        </aside>

        <section className="route-panel panel">
          <div className="panel-head">
            <h2>Route summary</h2>
            {route && <span className="method-tag">{route.method}</span>}
          </div>

          {!route && (
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
              onAmendPickup={amendPickup}
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
