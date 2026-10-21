import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildAutoMissionName,
  MAX_HAUL_STOPS,
  reconcileHaulStops,
} from '../lib/haulTypes'
import type { OcrRegionTexts } from '../lib/ocr'
import {
  CRATE_SIZES,
  createMission,
  normalizeCrateSize,
} from '../lib/spread'
import { OCR_REGION_IDS, OCR_REGION_LABELS } from '../lib/ocrRegions'
import { locationLabel } from '../store/catalog'
import type { HaulType, Location, Mission } from '../types'
import type { DraftCache } from '../lib/appCache'
import type { CommodityInfo } from '../api/uex'
import { CommodityPicker } from './CommodityPicker'
import { GiverPicker } from './GiverPicker'
import { HaulTypePicker } from './HaulTypePicker'
import { LocationPicker } from './LocationPicker'
import { OcrRegionSetup } from './OcrRegionSetup'
import { RankPicker } from './RankPicker'

export type MissionModalStep = 'add' | 'edit'

const FORM_UNDO_LIMIT = 40

type HeaderPrimary = {
  run: () => void
  disabled: boolean
  label: string
}

type HeaderHistory = {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

type MissionFormSnap = {
  code: string
  name: string
  giver: string
  rank: string
  haulType: HaulType
  totalScu: number
  maxUnitScu: number
  rewardAuec: number
  commodity: string
  pickupIds: string[]
  dropoffIds: string[]
  nameAuto: boolean
  demo: boolean
}

function formSnapKey(s: MissionFormSnap): string {
  return JSON.stringify(s)
}

export interface OcrBatchItem {
  missions: Mission[]
  regions: OcrRegionTexts
  /** Full OCR debug dump (region crops + extras) */
  text: string
  imageUrl: string | null
  source: File | Blob | null
}

function normalizeMissionCode(code: string): string {
  return code.trim().toUpperCase().slice(0, 5)
}

function formatRewardDigits(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return n === 0 ? '0' : ''
  return new Intl.NumberFormat('en-US').format(Math.round(n))
}

function parseRewardDigits(raw: string): number {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return 0
  const n = Number(digits)
  return Number.isFinite(n) ? n : 0
}

interface Props {
  step: MissionModalStep
  mission?: Mission | null
  /** All missions — used to validate code uniqueness */
  missions: Mission[]
  locations: Location[]
  commodities: CommodityInfo[]
  givers: string[]
  missionNames: string[]
  draftHaul: HaulType
  draft: DraftCache
  onDraftHaul: (h: HaulType) => void
  onDraft: (updater: (d: DraftCache) => DraftCache) => void
  onAddManual: () => void
  onSaveEdit: (mission: Mission) => void
  /** Remount form after OCR fill so pickups/dropoffs never stick */
  ocrFormKey?: number
  ocrItems: OcrBatchItem[]
  ocrIndex: number
  onOcrIndex: (index: number) => void
  /** When editing, OCR result to merge into the form */
  ocrFillMission?: Mission | null
  ocrBusy: boolean
  ocrProgress: number
  ocrStatus: string
  batchTotal: number
  batchDone: number
  pasteOpen: boolean
  pasteText: string
  onPasteOpen: (open: boolean) => void
  onPasteText: (text: string) => void
  onImportPaste: () => void
  onBrowse: () => void
  onDropFiles: (files: File[]) => void
  onRescan?: () => void
  onAddAll?: () => void
  /** Fill the add form with one demo sample (not saved until Add) */
  onAddDemo?: () => void
  onClose: () => void
}

export function MissionModal({
  step,
  mission,
  missions,
  locations,
  commodities,
  givers,
  missionNames,
  draftHaul,
  draft,
  onDraftHaul,
  onDraft,
  onAddManual,
  onSaveEdit,
  ocrFormKey = 0,
  ocrItems,
  ocrIndex,
  onOcrIndex,
  ocrFillMission = null,
  ocrBusy,
  ocrProgress,
  ocrStatus,
  batchTotal,
  batchDone,
  pasteOpen,
  pasteText,
  onPasteOpen,
  onPasteText,
  onImportPaste,
  onBrowse,
  onDropFiles,
  onRescan,
  onAddAll,
  onAddDemo,
  onClose,
}: Props) {
  const [regionsOpen, setRegionsOpen] = useState(false)
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.classList.add('modal-open')
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.classList.remove('modal-open')
      document.body.style.overflow = prev
    }
  }, [])

  const current = ocrItems[ocrIndex]
  const multi = batchTotal > 1 || ocrItems.length > 1
  const batchLabelTotal = Math.max(batchTotal, ocrItems.length, 1)
  const progressPct = Math.round(Math.min(1, Math.max(0, ocrProgress)) * 100)
  const readyCount = ocrItems.length
  const [headerPrimary, setHeaderPrimary] = useState<HeaderPrimary | null>(null)
  const registerPrimary = useCallback((api: HeaderPrimary | null) => {
    setHeaderPrimary(api)
  }, [])
  const [headerHistory, setHeaderHistory] = useState<HeaderHistory | null>(null)
  const registerHistory = useCallback((api: HeaderHistory | null) => {
    setHeaderHistory(api)
  }, [])
  const [editTitle, setEditTitle] = useState<{
    code: string
    name: string
    onCode: (v: string) => void
    onName: (v: string) => void
  } | null>(null)
  const registerEditTitle = useCallback(
    (
      meta: {
        code: string
        name: string
        onCode: (v: string) => void
        onName: (v: string) => void
      } | null,
    ) => {
      setEditTitle(meta)
    },
    [],
  )

  const [nameAuto, setNameAuto] = useState(() => !draft.name.trim())
  const [titleEditing, setTitleEditing] = useState<'code' | 'name' | null>(null)
  const titleCodeRef = useRef<HTMLInputElement>(null)
  const titleNameRef = useRef<HTMLInputElement>(null)
  const titleFieldsRef = useRef<HTMLDivElement>(null)
  /** Code value when edit mode started — restored if exit while invalid. */
  const titleCodeBackupRef = useRef('')
  const codeErrorRef = useRef('')
  /** Invalid codes dismissed on exit — Undo restores them into code edit mode. */
  const codeErrorUndoStack = useRef<string[]>([])
  const codeErrorRedoStack = useRef<string[]>([])
  /** Last auto-generated name we applied — location changes keep syncing while name matches this. */
  const lastAutoNameRef = useRef('')
  const undoStack = useRef<MissionFormSnap[]>([])
  const redoStack = useRef<MissionFormSnap[]>([])
  const debounceBase = useRef<MissionFormSnap | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const applyingHistory = useRef(false)
  const [histTick, setHistTick] = useState(0)

  function computeAddAutoName(
    d: DraftCache = draft,
    haul: HaulType = draftHaul,
  ): string {
    const from = d.pickupIds[0] ? locationLabel(d.pickupIds[0]) : ''
    const to = d.dropoffIds.length
      ? locationLabel(d.dropoffIds[d.dropoffIds.length - 1])
      : ''
    return buildAutoMissionName({
      giver: d.giver,
      rank: d.rank,
      haulType: haul,
      from,
      to,
      pickupCount: d.pickupIds.length,
      dropoffCount: d.dropoffIds.length,
      demo: Boolean(d.demo),
    })
  }

  function currentAddSnap(): MissionFormSnap {
    return {
      code: draft.code,
      name: draft.name,
      giver: draft.giver,
      rank: draft.rank,
      haulType: draftHaul,
      totalScu: draft.totalScu,
      maxUnitScu: draft.maxUnitScu,
      rewardAuec: draft.rewardAuec,
      commodity: draft.commodity,
      pickupIds: [...draft.pickupIds],
      dropoffIds: [...draft.dropoffIds],
      nameAuto,
      demo: Boolean(draft.demo),
    }
  }

  function applyAddSnap(s: MissionFormSnap) {
    applyingHistory.current = true
    setNameAuto(s.nameAuto)
    lastAutoNameRef.current = s.nameAuto ? s.name : ''
    onDraftHaul(s.haulType)
    onDraft(() => ({
      code: s.code,
      name: s.name,
      giver: s.giver,
      rank: s.rank,
      pickupIds: [...s.pickupIds],
      dropoffIds: [...s.dropoffIds],
      totalScu: s.totalScu,
      maxUnitScu: s.maxUnitScu,
      rewardAuec: s.rewardAuec,
      commodity: s.commodity,
      demo: s.demo,
    }))
    queueMicrotask(() => {
      applyingHistory.current = false
    })
  }

  function flushFormHistory() {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    if (debounceBase.current) {
      const base = debounceBase.current
      debounceBase.current = null
      const cur = currentAddSnap()
      if (formSnapKey(base) !== formSnapKey(cur)) {
        undoStack.current = [...undoStack.current, base].slice(-FORM_UNDO_LIMIT)
        redoStack.current = []
        setHistTick((t) => t + 1)
      }
    }
  }

  function noteFormEdit() {
    if (applyingHistory.current || step !== 'add') return
    if (!debounceBase.current) debounceBase.current = currentAddSnap()
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => flushFormHistory(), 450)
  }

  function currentTitleCode(): string {
    return step === 'add'
      ? draft.code
      : editTitle?.code ?? mission?.code ?? ''
  }

  function applyTitleCode(code: string) {
    if (step === 'add') {
      onDraft((d) => ({ ...d, code }))
    } else {
      editTitle?.onCode(code)
    }
  }

  function undoCodeErrorEdit() {
    const invalid = codeErrorUndoStack.current[codeErrorUndoStack.current.length - 1]
    if (invalid == null) return false
    codeErrorUndoStack.current = codeErrorUndoStack.current.slice(0, -1)
    const valid = currentTitleCode()
    codeErrorRedoStack.current = [...codeErrorRedoStack.current, valid].slice(
      -FORM_UNDO_LIMIT,
    )
    titleCodeBackupRef.current = valid
    applyTitleCode(invalid)
    setTitleEditing('code')
    setHistTick((t) => t + 1)
    return true
  }

  function redoCodeErrorEdit() {
    const valid = codeErrorRedoStack.current[codeErrorRedoStack.current.length - 1]
    if (valid == null) return false
    codeErrorRedoStack.current = codeErrorRedoStack.current.slice(0, -1)
    const invalid = currentTitleCode()
    codeErrorUndoStack.current = [...codeErrorUndoStack.current, invalid].slice(
      -FORM_UNDO_LIMIT,
    )
    titleCodeBackupRef.current = valid
    applyTitleCode(valid)
    setTitleEditing(null)
    setHistTick((t) => t + 1)
    return true
  }

  function undoForm() {
    if (undoCodeErrorEdit()) return
    codeErrorRedoStack.current = []
    if (step !== 'add') {
      headerHistory?.undo()
      return
    }
    flushFormHistory()
    const prev = undoStack.current[undoStack.current.length - 1]
    if (!prev) return
    redoStack.current = [...redoStack.current, currentAddSnap()].slice(
      -FORM_UNDO_LIMIT,
    )
    undoStack.current = undoStack.current.slice(0, -1)
    applyAddSnap(prev)
    setTitleEditing(null)
    setHistTick((t) => t + 1)
  }

  function redoForm() {
    if (redoCodeErrorEdit()) return
    if (step !== 'add') {
      headerHistory?.redo()
      return
    }
    flushFormHistory()
    const next = redoStack.current[redoStack.current.length - 1]
    if (!next) return
    undoStack.current = [...undoStack.current, currentAddSnap()].slice(
      -FORM_UNDO_LIMIT,
    )
    redoStack.current = redoStack.current.slice(0, -1)
    applyAddSnap(next)
    setTitleEditing(null)
    setHistTick((t) => t + 1)
  }

  useEffect(() => {
    undoStack.current = []
    redoStack.current = []
    codeErrorUndoStack.current = []
    codeErrorRedoStack.current = []
    debounceBase.current = null
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    if (step === 'add') {
      const auto = computeAddAutoName()
      const current = draft.name.trim()
      const usingAuto = !current || current === auto
      setNameAuto(usingAuto)
      lastAutoNameRef.current = usingAuto ? auto : ''
    } else {
      setNameAuto(!mission?.name?.trim())
      lastAutoNameRef.current = ''
    }
    setTitleEditing(null)
    setHistTick((t) => t + 1)
    // Reset history when opening / switching missions
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional on step/mission id
  }, [step, mission?.id, ocrFormKey])

  useEffect(() => {
    if (!titleEditing) return
    const el = titleEditing === 'code' ? titleCodeRef.current : titleNameRef.current
    el?.focus()
    el?.select()
  }, [titleEditing])

  function beginTitleEdit(field: 'code' | 'name') {
    if (field === 'code') {
      titleCodeBackupRef.current = currentTitleCode()
    }
    setTitleEditing(field)
  }

  function endTitleEdit() {
    if (titleEditing === 'code' && codeErrorRef.current) {
      const invalid = currentTitleCode()
      const backup = titleCodeBackupRef.current
      if (
        normalizeMissionCode(invalid) !== normalizeMissionCode(backup)
      ) {
        codeErrorUndoStack.current = [
          ...codeErrorUndoStack.current,
          invalid,
        ].slice(-FORM_UNDO_LIMIT)
        codeErrorRedoStack.current = []
        setHistTick((t) => t + 1)
      }
      applyTitleCode(backup)
    }
    setTitleEditing(null)
  }

  useEffect(() => {
    if (!titleEditing) return
    const onDoc = (e: MouseEvent) => {
      if (!titleFieldsRef.current?.contains(e.target as Node)) {
        endTitleEdit()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endTitleEdit()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
    // endTitleEdit closes over latest codeErrorRef / backup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleEditing, step, editTitle, draft.code])

  const editIcon = (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
      <path
        fill="currentColor"
        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.04a1 1 0 0 0 0-1.41l-2.51-2.51a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.99-1.66z"
      />
    </svg>
  )

  useEffect(() => {
    if (step !== 'add' || applyingHistory.current) return
    const next = computeAddAutoName()
    const current = draft.name.trim()
    const stillAuto =
      nameAuto || !current || current === lastAutoNameRef.current
    if (!stillAuto) return
    if (!nameAuto) setNameAuto(true)
    lastAutoNameRef.current = next
    if (current === next) return
    applyingHistory.current = true
    onDraft((d) => ({ ...d, name: next }))
    queueMicrotask(() => {
      applyingHistory.current = false
    })
  }, [
    step,
    nameAuto,
    draft.giver,
    draft.rank,
    draft.demo,
    draftHaul,
    draft.pickupIds,
    draft.dropoffIds,
    draft.name,
    onDraft,
  ])

  useEffect(() => {
    if (step !== 'add') return
    registerHistory({
      undo: undoForm,
      redo: redoForm,
      canUndo: undoStack.current.length > 0 || Boolean(debounceBase.current),
      canRedo: redoStack.current.length > 0,
    })
    return () => registerHistory(null)
    // histTick refreshes canUndo/canRedo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, histTick, registerHistory])

  function patchDraft(updater: (d: DraftCache) => DraftCache) {
    noteFormEdit()
    onDraft(updater)
  }

  function patchHaul(h: HaulType) {
    noteFormEdit()
    onDraftHaul(h)
  }

  const titleCode =
    step === 'add' ? draft.code : editTitle?.code ?? mission?.code ?? ''
  const titleName =
    step === 'add'
      ? draft.name
      : editTitle?.name ?? mission?.name ?? ''

  function onTitleCode(v: string) {
    const next = v.slice(0, 5)
    if (step === 'add') patchDraft((d) => ({ ...d, code: next }))
    else editTitle?.onCode(next)
  }

  function onTitleName(v: string) {
    if (step === 'add') {
      noteFormEdit()
      if (!v.trim()) {
        const next = computeAddAutoName()
        setNameAuto(true)
        lastAutoNameRef.current = next
        onDraft((d) => ({ ...d, name: next }))
        return
      }
      setNameAuto(false)
      lastAutoNameRef.current = ''
      onDraft((d) => ({ ...d, name: v }))
      return
    }
    editTitle?.onName(v)
  }

  function resetNameToAuto() {
    onTitleName('')
  }

  const codeNorm = normalizeMissionCode(titleCode)
  const codeTaken =
    Boolean(codeNorm) &&
    missions.some(
      (m) =>
        m.id !== mission?.id &&
        normalizeMissionCode(m.code) === codeNorm,
    )
  const codeError = codeTaken
    ? `Code ${codeNorm} is already used`
    : !codeNorm
      ? 'Mission code is required'
      : ''
  codeErrorRef.current = codeError

  const canUndo =
    codeErrorUndoStack.current.length > 0 ||
    (step === 'add'
      ? undoStack.current.length > 0 || Boolean(debounceBase.current)
      : Boolean(headerHistory?.canUndo))
  const canRedo =
    codeErrorRedoStack.current.length > 0 ||
    (step === 'add'
      ? redoStack.current.length > 0
      : Boolean(headerHistory?.canRedo))

  return (
    <>
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal panel mission-modal"
        role="dialog"
        aria-labelledby="mission-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head mission-modal-head">
          <div className="mission-modal-title-block" ref={titleFieldsRef}>
            <h2 id="mission-modal-title">
              {step === 'add' ? 'Add mission' : 'Edit mission'}
            </h2>
            <div className="mission-modal-title-fields is-display">
              <div className="mission-title-code-group">
                {titleEditing === 'code' ? (
                  <input
                    ref={titleCodeRef}
                    className={`mission-title-code${codeError ? ' invalid' : ''}`}
                    value={titleCode}
                    onChange={(e) => onTitleCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') endTitleEdit()
                    }}
                    placeholder={draft.demo ? 'D01' : 'C01'}
                    maxLength={5}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Mission code"
                    aria-invalid={Boolean(codeError)}
                  />
                ) : (
                  <div
                    className={`mission-title-shell mission-title-code-shell${codeError ? ' invalid' : ''}`}
                    title={codeError || 'Double-click to edit code'}
                    onDoubleClick={() => beginTitleEdit('code')}
                  >
                    <span className="mission-title-shell-text mission-title-code-text">
                      {titleCode.trim() || (draft.demo ? 'D01' : 'C01')}
                    </span>
                    <button
                      type="button"
                      className="mission-title-edit-btn"
                      title="Edit code"
                      aria-label="Edit code"
                      onClick={(e) => {
                        e.stopPropagation()
                        beginTitleEdit('code')
                      }}
                    >
                      {editIcon}
                    </button>
                  </div>
                )}
              </div>
              <div className="mission-title-name-group">
                {titleEditing === 'name' ? (
                  <div className="mission-title-name-wrap">
                    <input
                      ref={titleNameRef}
                      className="mission-title-name"
                      list="mission-modal-title-names"
                      value={titleName}
                      onChange={(e) => onTitleName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setTitleEditing(null)
                      }}
                      placeholder="Giver | Rank | Haul | From … / To …"
                      aria-label="Mission name"
                    />
                    <button
                      type="button"
                      className="ghost icon-btn mission-title-name-clear"
                      onClick={resetNameToAuto}
                      title="Reset to auto name"
                      aria-label="Reset mission name to auto"
                    >
                      ↺
                    </button>
                    <datalist id="mission-modal-title-names">
                      {missionNames.map((n) => (
                        <option key={n} value={n} />
                      ))}
                    </datalist>
                  </div>
                ) : (
                  <div
                    className="mission-title-shell mission-title-name-shell"
                    title="Double-click to edit name"
                    onDoubleClick={() => beginTitleEdit('name')}
                  >
                    <TitleMarquee
                      text={titleName.trim() || 'Mission name'}
                      onDoubleClick={() => beginTitleEdit('name')}
                    />
                    <button
                      type="button"
                      className="mission-title-edit-btn"
                      title="Edit name"
                      aria-label="Edit name"
                      onClick={(e) => {
                        e.stopPropagation()
                        beginTitleEdit('name')
                      }}
                    >
                      {editIcon}
                    </button>
                  </div>
                )}
              </div>
            </div>
            {codeError ? (
              <span className="mission-code-error" role="alert" title={codeError}>
                {codeError}
              </span>
            ) : null}
          </div>
          <div className="panel-actions">
            <button
              type="button"
              className="ghost icon-btn"
              disabled={!canUndo}
              onClick={undoForm}
              title={canUndo ? 'Undo' : 'Nothing to undo'}
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
              disabled={!canRedo}
              onClick={redoForm}
              title={canRedo ? 'Redo' : 'Nothing to redo'}
              aria-label="Redo"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                <path
                  fill="currentColor"
                  d="M11.5 8c2.65 0 5.05 1 6.9 2.6L21 8v6h-6l2.25-2.25A7.96 7.96 0 0 0 11.5 10c-3.04 0-5.64 1.7-6.94 4.2l-1.8-.9C4.4 10.2 7.7 8 11.5 8z"
                />
              </svg>
            </button>
            {step === 'add' && onAddDemo && (
              <button
                type="button"
                className="ghost demo-btn"
                onClick={onAddDemo}
                title="Fill form with an SCMDB sample haul"
              >
                Demo
              </button>
            )}
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={(headerPrimary?.disabled ?? true) || Boolean(codeError)}
              onClick={() => {
                if (codeError) return
                headerPrimary?.run()
              }}
            >
              {headerPrimary?.label ??
                (step === 'add' ? 'Add mission' : 'Save changes')}
            </button>
          </div>
        </div>

        <div className="mission-modal-body">
          {(ocrBusy || (batchTotal > 0 && batchDone < batchTotal)) && (
            <div className="ocr-progress-block">
              <div className="ocr-progress-bar" aria-hidden>
                <i style={{ width: `${progressPct}%` }} />
              </div>
              <p className="ocr-status">
                {ocrStatus || 'Scanning…'}
                {batchTotal > 1
                  ? ` · ${batchDone}/${batchTotal}`
                  : progressPct > 0
                    ? ` · ${progressPct}%`
                    : ''}
              </p>
            </div>
          )}

          {step === 'add' && (
            <div className="add-mission-combined">
              <OcrUploadBlock
                regionsOpen={regionsOpen}
                onToggleRegions={() => setRegionsOpen((v) => !v)}
                ocrBusy={ocrBusy}
                progressPct={progressPct}
                onBrowse={onBrowse}
                onDropFiles={onDropFiles}
                pasteOpen={pasteOpen}
                pasteText={pasteText}
                onPasteOpen={onPasteOpen}
                onPasteText={onPasteText}
                onImportPaste={onImportPaste}
                current={current}
                multi={multi}
                ocrIndex={ocrIndex}
                batchLabelTotal={batchLabelTotal}
                readyCount={readyCount}
                onOcrIndex={onOcrIndex}
                onRescan={onRescan}
                onAddAll={onAddAll}
              />

              <MissionForm
                key={`add-ocr-${ocrFormKey}-${ocrIndex}`}
                idPrefix="add"
                haulType={draftHaul}
                giver={draft.giver}
                rank={draft.rank}
                showGiver
                totalScu={draft.totalScu}
                maxUnitScu={draft.maxUnitScu}
                rewardAuec={draft.rewardAuec}
                commodity={draft.commodity}
                pickupIds={draft.pickupIds}
                dropoffIds={draft.dropoffIds}
                locations={locations}
                commodities={commodities}
                givers={givers}
                onHaulType={patchHaul}
                onGiver={(giver) => patchDraft((d) => ({ ...d, giver }))}
                onRank={(rank) => patchDraft((d) => ({ ...d, rank }))}
                onTotalScu={(totalScu) => patchDraft((d) => ({ ...d, totalScu }))}
                onMaxUnitScu={(maxUnitScu) =>
                  patchDraft((d) => ({ ...d, maxUnitScu }))
                }
                onRewardAuec={(rewardAuec) =>
                  patchDraft((d) => ({ ...d, rewardAuec }))
                }
                onCommodity={(commodity) =>
                  patchDraft((d) => ({ ...d, commodity }))
                }
                onPickupIds={(pickupIds) =>
                  patchDraft((d) => ({
                    ...d,
                    ...reconcileHaulStops(pickupIds, d.dropoffIds, 'pickup'),
                  }))
                }
                onDropoffIds={(dropoffIds) =>
                  patchDraft((d) => ({
                    ...d,
                    ...reconcileHaulStops(d.pickupIds, dropoffIds, 'dropoff'),
                  }))
                }
                primaryLabel={
                  multi && readyCount > 1 ? 'Add & next' : 'Add mission'
                }
                primaryDisabled={Boolean(codeError)}
                onPrimary={onAddManual}
                onCancel={onClose}
                registerPrimary={registerPrimary}
                batchNav={
                  multi
                    ? {
                        index: ocrIndex,
                        total: batchLabelTotal,
                        ready: readyCount,
                        onPrev: () => onOcrIndex(Math.max(0, ocrIndex - 1)),
                        onNext: () =>
                          onOcrIndex(Math.min(readyCount - 1, ocrIndex + 1)),
                      }
                    : undefined
                }
              />
            </div>
          )}

          {step === 'edit' && mission && (
            <EditMissionBody
              mission={mission}
              ocrFill={ocrFillMission}
              locations={locations}
              commodities={commodities}
              givers={givers}
              scanBusy={ocrBusy}
              codeInvalid={Boolean(codeError)}
              onScanFile={(file) => onDropFiles([file])}
              onSave={onSaveEdit}
              onCancel={onClose}
              registerPrimary={registerPrimary}
              registerHistory={registerHistory}
              registerEditTitle={registerEditTitle}
              ocrImageUrl={current?.imageUrl ?? null}
              ocrRegions={current?.regions}
              canRescan={Boolean(current?.source && onRescan)}
              onRescan={onRescan}
            />
          )}
        </div>
      </div>
    </div>

    {regionsOpen && (
      <OcrRegionSetup variant="modal" onClose={() => setRegionsOpen(false)} />
    )}
    </>
  )
}

/** Collapsible per-region OCR text for debug (not full-image dump). */
function OcrExpandedDebug({ regions }: { regions?: OcrRegionTexts }) {
  if (!regions) return null
  const hasAny = OCR_REGION_IDS.some((id) => regions[id]?.trim())
  if (!hasAny) return null

  return (
    <details className="ocr-raw ocr-raw-expanded">
      <summary>OCR regions (debug)</summary>
      <div className="ocr-region-raw-list">
        {OCR_REGION_IDS.map((id) => (
          <div key={id} className="ocr-region-raw">
            <strong>{OCR_REGION_LABELS[id]}</strong>
            <pre>{regions[id]?.trim() || '(empty)'}</pre>
          </div>
        ))}
      </div>
    </details>
  )
}

const ZOOM_MIN = 0.5
const ZOOM_MAX = 4
const ZOOM_STEP = 0.25

/** Old-style zoom/pan screenshot stage */
function OcrImagePreview({ imageUrl }: { imageUrl: string }) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [imageUrl])

  const clampZoom = useCallback(
    (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)),
    [],
  )

  function zoomBy(delta: number) {
    setZoom((z) => clampZoom(Math.round((z + delta) / ZOOM_STEP) * ZOOM_STEP))
  }

  return (
    <div className="ocr-image-preview">
      <div className="ocr-zoom-bar">
        <button type="button" className="ghost" onClick={() => zoomBy(-ZOOM_STEP)}>
          −
        </button>
        <span className="ocr-zoom-label">{Math.round(zoom * 100)}%</span>
        <button type="button" className="ghost" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setZoom(1)
            setPan({ x: 0, y: 0 })
          }}
        >
          Reset
        </button>
        <span className="hint tight">Scroll to zoom · drag to pan</span>
      </div>
      <div
        className="ocr-image-stage"
        onWheel={(e) => {
          e.preventDefault()
          zoomBy(e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          setPan({
            x: drag.current.panX + (e.clientX - drag.current.x),
            y: drag.current.panY + (e.clientY - drag.current.y),
          })
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <img
          src={imageUrl}
          alt="OCR source"
          draggable={false}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        />
      </div>
    </div>
  )
}

function OcrUploadBlock({
  regionsOpen,
  onToggleRegions,
  ocrBusy,
  progressPct,
  onBrowse,
  onDropFiles,
  pasteOpen,
  pasteText,
  onPasteOpen,
  onPasteText,
  onImportPaste,
  current,
  multi,
  ocrIndex,
  batchLabelTotal,
  readyCount,
  onOcrIndex,
  onRescan,
  onAddAll,
}: {
  regionsOpen: boolean
  onToggleRegions: () => void
  ocrBusy: boolean
  progressPct: number
  onBrowse: () => void
  onDropFiles: (files: File[]) => void
  pasteOpen: boolean
  pasteText: string
  onPasteOpen: (open: boolean) => void
  onPasteText: (text: string) => void
  onImportPaste: () => void
  current?: OcrBatchItem
  multi: boolean
  ocrIndex: number
  batchLabelTotal: number
  readyCount: number
  onOcrIndex: (index: number) => void
  onRescan?: () => void
  onAddAll?: () => void
}) {
  return (
    <div className="ocr-upload-block">
      <div className="ocr-upload-head">
        <span className="ocr-upload-title">Contract screenshot</span>
        <button
          type="button"
          className={regionsOpen ? 'ghost ocr-regions-gear open' : 'ghost ocr-regions-gear'}
          aria-expanded={regionsOpen}
          aria-haspopup="dialog"
          aria-label="OCR region setup"
          title="OCR detection regions"
          onClick={onToggleRegions}
        >
          <svg className="ocr-gear-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path
              fill="currentColor"
              d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.2 7.2 0 0 0-1.62-.94l-.36-2.54A.48.48 0 0 0 14 2h-4a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.65 8.47a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.77 14.5a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.3.59.22l2.39-.96c.5.39 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h4c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"
            />
          </svg>
        </button>
      </div>

      <div
        className="ocr-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          onDropFiles([...(e.dataTransfer.files ?? [])])
        }}
      >
        <p className="hint tight">Drop images, Ctrl+V paste, or browse (multi-select)</p>
        <div className="ocr-actions">
          <button type="button" className="primary" disabled={ocrBusy} onClick={onBrowse}>
            {ocrBusy ? `${progressPct}%` : 'Browse'}
          </button>
          <button type="button" className="ghost" onClick={() => onPasteOpen(!pasteOpen)}>
            Paste text
          </button>
        </div>
      </div>

      {pasteOpen && (
        <div className="paste-box">
          <textarea
            value={pasteText}
            onChange={(e) => onPasteText(e.target.value)}
            rows={5}
            placeholder="Paste contract details…"
          />
          <button type="button" className="primary" onClick={onImportPaste}>
            Parse & fill
          </button>
        </div>
      )}

      {(current?.imageUrl || readyCount > 0) && (
        <div className="ocr-scan-result">
          {multi && (
            <div className="ocr-batch-nav">
              <button
                type="button"
                className="ghost"
                disabled={ocrIndex <= 0}
                onClick={() => onOcrIndex(ocrIndex - 1)}
              >
                Prev
              </button>
              <span className="ocr-batch-label">
                Image {ocrIndex + 1} of {batchLabelTotal}
                {readyCount < batchLabelTotal ? ` · ${readyCount} ready` : ''}
              </span>
              <button
                type="button"
                className="ghost"
                disabled={ocrIndex >= readyCount - 1}
                onClick={() => onOcrIndex(ocrIndex + 1)}
              >
                Next
              </button>
            </div>
          )}

          {current?.imageUrl ? (
            <OcrImagePreview imageUrl={current.imageUrl} />
          ) : (
            <p className="hint tight">
              {ocrBusy ? 'Waiting for the first screenshot…' : 'No image for this scan'}
            </p>
          )}

          <OcrExpandedDebug regions={current?.regions} />

          <p className="hint tight">
            {current?.missions[0]
              ? 'Fields below are filled from this scan — edit then add'
              : ocrBusy
                ? 'Scanning…'
                : 'No mission parsed from this image'}
          </p>
          <div className="ocr-actions">
            {current?.source && onRescan && (
              <button type="button" className="ghost" disabled={ocrBusy} onClick={onRescan}>
                Rescan
              </button>
            )}
            {multi && onAddAll && readyCount > 1 && (
              <button type="button" className="ghost" onClick={onAddAll}>
                Add all ready
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function EditMissionBody({
  mission,
  ocrFill,
  locations,
  commodities,
  givers,
  scanBusy,
  codeInvalid = false,
  onScanFile,
  onSave,
  onCancel,
  registerPrimary,
  registerHistory,
  registerEditTitle,
  ocrImageUrl,
  ocrRegions,
  canRescan,
  onRescan,
}: {
  mission: Mission
  ocrFill?: Mission | null
  locations: Location[]
  commodities: CommodityInfo[]
  givers: string[]
  scanBusy: boolean
  codeInvalid?: boolean
  onScanFile: (file: File) => void
  onSave: (mission: Mission) => void
  onCancel: () => void
  registerPrimary?: (api: HeaderPrimary | null) => void
  registerHistory?: (api: HeaderHistory | null) => void
  registerEditTitle?: (
    meta: {
      code: string
      name: string
      onCode: (v: string) => void
      onName: (v: string) => void
    } | null,
  ) => void
  ocrImageUrl?: string | null
  ocrRegions?: OcrRegionTexts
  canRescan?: boolean
  onRescan?: () => void
}) {
  const [haulType, setHaulType] = useState<HaulType>(mission.haulType)
  const [code, setCode] = useState(mission.code)
  const [name, setName] = useState(mission.name)
  const [giver, setGiver] = useState(mission.giver ?? '')
  const [rank, setRank] = useState(mission.rank ?? '')
  const [nameAuto, setNameAuto] = useState(!mission.name.trim())
  const [totalScu, setTotalScu] = useState(mission.totalScu)
  const [maxUnitScu, setMaxUnitScu] = useState(normalizeCrateSize(mission.maxUnitScu))
  const [rewardAuec, setRewardAuec] = useState(mission.rewardAuec ?? 0)
  const [commodity, setCommodity] = useState(mission.commodity ?? '')
  const [pickupIds, setPickupIds] = useState(mission.pickups.map((p) => p.locationId))
  const [dropoffIds, setDropoffIds] = useState(mission.dropoffs.map((d) => d.locationId))
  const scanRef = useRef<HTMLInputElement>(null)
  const appliedFill = useRef<string | null>(null)
  const lastAutoNameRef = useRef('')
  const undoStack = useRef<MissionFormSnap[]>([])
  const redoStack = useRef<MissionFormSnap[]>([])
  const debounceBase = useRef<MissionFormSnap | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const applyingHistory = useRef(false)
  const [histTick, setHistTick] = useState(0)

  function computeEditAutoName(
    nextGiver = giver,
    nextRank = rank,
    nextHaul = haulType,
    nextPickups = pickupIds,
    nextDropoffs = dropoffIds,
  ): string {
    const from = nextPickups[0] ? locationLabel(nextPickups[0]) : ''
    const to = nextDropoffs.length
      ? locationLabel(nextDropoffs[nextDropoffs.length - 1])
      : ''
    const demo =
      mission.source === 'demo' || name.trim().startsWith('(DEMO)')
    return buildAutoMissionName({
      giver: nextGiver,
      rank: nextRank,
      haulType: nextHaul,
      from,
      to,
      pickupCount: nextPickups.length,
      dropoffCount: nextDropoffs.length,
      demo,
    })
  }

  function currentSnap(): MissionFormSnap {
    return {
      code,
      name,
      giver,
      rank,
      haulType,
      totalScu,
      maxUnitScu,
      rewardAuec,
      commodity,
      pickupIds: [...pickupIds],
      dropoffIds: [...dropoffIds],
      nameAuto,
      demo: mission.source === 'demo' || name.trim().startsWith('(DEMO)'),
    }
  }

  function applySnap(s: MissionFormSnap) {
    applyingHistory.current = true
    setCode(s.code)
    setName(s.name)
    setGiver(s.giver)
    setRank(s.rank)
    setHaulType(s.haulType)
    setTotalScu(s.totalScu)
    setMaxUnitScu(normalizeCrateSize(s.maxUnitScu))
    setRewardAuec(s.rewardAuec)
    setCommodity(s.commodity)
    setPickupIds([...s.pickupIds])
    setDropoffIds([...s.dropoffIds])
    setNameAuto(s.nameAuto)
    lastAutoNameRef.current = s.nameAuto ? s.name : ''
    queueMicrotask(() => {
      applyingHistory.current = false
    })
  }

  function flushHistory() {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    if (debounceBase.current) {
      const base = debounceBase.current
      debounceBase.current = null
      if (formSnapKey(base) !== formSnapKey(currentSnap())) {
        undoStack.current = [...undoStack.current, base].slice(-FORM_UNDO_LIMIT)
        redoStack.current = []
        setHistTick((t) => t + 1)
      }
    }
  }

  function noteEdit() {
    if (applyingHistory.current) return
    if (!debounceBase.current) debounceBase.current = currentSnap()
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => flushHistory(), 450)
  }

  function undo() {
    flushHistory()
    const prev = undoStack.current[undoStack.current.length - 1]
    if (!prev) return
    redoStack.current = [...redoStack.current, currentSnap()].slice(-FORM_UNDO_LIMIT)
    undoStack.current = undoStack.current.slice(0, -1)
    applySnap(prev)
    setHistTick((t) => t + 1)
  }

  function redo() {
    flushHistory()
    const next = redoStack.current[redoStack.current.length - 1]
    if (!next) return
    undoStack.current = [...undoStack.current, currentSnap()].slice(-FORM_UNDO_LIMIT)
    redoStack.current = redoStack.current.slice(0, -1)
    applySnap(next)
    setHistTick((t) => t + 1)
  }

  useEffect(() => {
    if (!registerHistory) return
    registerHistory({
      undo,
      redo,
      canUndo: undoStack.current.length > 0 || Boolean(debounceBase.current),
      canRedo: redoStack.current.length > 0,
    })
    return () => registerHistory(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerHistory, histTick])

  useEffect(() => {
    registerEditTitle?.({
      code,
      name,
      onCode: (v) => {
        noteEdit()
        setCode(v.slice(0, 5))
      },
      onName: (v) => {
        noteEdit()
        if (!v.trim()) {
          const next = computeEditAutoName()
          setNameAuto(true)
          lastAutoNameRef.current = next
          setName(next)
          return
        }
        setNameAuto(false)
        lastAutoNameRef.current = ''
        setName(v)
      },
    })
    return () => registerEditTitle?.(null)
  }, [
    code,
    name,
    giver,
    rank,
    haulType,
    pickupIds,
    dropoffIds,
    registerEditTitle,
  ])

  useEffect(() => {
    const picks = mission.pickups.map((p) => p.locationId)
    const drops = mission.dropoffs.map((d) => d.locationId)
    const auto = buildAutoMissionName({
      giver: mission.giver ?? '',
      rank: mission.rank ?? '',
      haulType: mission.haulType,
      from: picks[0] ? locationLabel(picks[0]) : '',
      to: drops.length ? locationLabel(drops[drops.length - 1]) : '',
      pickupCount: picks.length,
      dropoffCount: drops.length,
      demo:
        mission.source === 'demo' ||
        mission.name.trim().startsWith('(DEMO)'),
    })
    const current = mission.name.trim()
    const usingAuto = !current || current === auto
    setHaulType(mission.haulType)
    setCode(mission.code)
    setName(mission.name)
    setGiver(mission.giver ?? '')
    setRank(mission.rank ?? '')
    setNameAuto(usingAuto)
    lastAutoNameRef.current = usingAuto ? auto : ''
    setTotalScu(mission.totalScu)
    setMaxUnitScu(normalizeCrateSize(mission.maxUnitScu))
    setRewardAuec(mission.rewardAuec ?? 0)
    setCommodity(mission.commodity ?? '')
    setPickupIds(picks)
    setDropoffIds(drops)
    appliedFill.current = null
    undoStack.current = []
    redoStack.current = []
    debounceBase.current = null
    setHistTick((t) => t + 1)
  }, [mission])

  useEffect(() => {
    if (!ocrFill) return
    const key = `${ocrFill.id}:${ocrFill.name}:${ocrFill.totalScu}:${ocrFill.rewardAuec ?? 0}`
    if (appliedFill.current === key) return
    appliedFill.current = key
    noteEdit()
    setHaulType(ocrFill.haulType)
    setName(ocrFill.name)
    setNameAuto(false)
    lastAutoNameRef.current = ''
    setGiver(ocrFill.giver ?? '')
    setRank(ocrFill.rank ?? '')
    setTotalScu(ocrFill.totalScu)
    setMaxUnitScu(normalizeCrateSize(ocrFill.maxUnitScu))
    setRewardAuec(ocrFill.rewardAuec ?? 0)
    setCommodity(ocrFill.commodity ?? '')
    setPickupIds(ocrFill.pickups.map((p) => p.locationId))
    setDropoffIds(ocrFill.dropoffs.map((d) => d.locationId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocrFill])

  useEffect(() => {
    if (applyingHistory.current) return
    const next = computeEditAutoName()
    const current = name.trim()
    const stillAuto =
      nameAuto || !current || current === lastAutoNameRef.current
    if (!stillAuto) return
    if (!nameAuto) setNameAuto(true)
    lastAutoNameRef.current = next
    if (current === next) return
    applyingHistory.current = true
    setName(next)
    queueMicrotask(() => {
      applyingHistory.current = false
    })
  }, [nameAuto, giver, rank, haulType, pickupIds, dropoffIds, name])

  return (
    <>
      <div className="ocr-actions edit-scan-row">
        <input
          ref={scanRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) onScanFile(f)
          }}
        />
        <button
          type="button"
          className="ghost"
          disabled={scanBusy}
          onClick={() => scanRef.current?.click()}
        >
          {scanBusy ? 'Scanning…' : 'Scan screenshot'}
        </button>
        {canRescan && onRescan && (
          <button type="button" className="ghost" disabled={scanBusy} onClick={onRescan}>
            Rescan
          </button>
        )}
        <span className="hint tight">Fills the fields below from a contract image</span>
      </div>

      {ocrImageUrl && <OcrImagePreview imageUrl={ocrImageUrl} />}
      <OcrExpandedDebug regions={ocrRegions} />

      <MissionForm
        idPrefix="edit"
        haulType={haulType}
        giver={giver}
        rank={rank}
        showGiver
        totalScu={totalScu}
        maxUnitScu={maxUnitScu}
        rewardAuec={rewardAuec}
        commodity={commodity}
        pickupIds={pickupIds}
        dropoffIds={dropoffIds}
        locations={locations}
        commodities={commodities}
        givers={givers}
        onHaulType={(v) => {
          noteEdit()
          setHaulType(v)
        }}
        onGiver={(v) => {
          noteEdit()
          setGiver(v)
        }}
        onRank={(v) => {
          noteEdit()
          setRank(v)
        }}
        onTotalScu={(v) => {
          noteEdit()
          setTotalScu(v)
        }}
        onMaxUnitScu={(v) => {
          noteEdit()
          setMaxUnitScu(normalizeCrateSize(v))
        }}
        onRewardAuec={(v) => {
          noteEdit()
          setRewardAuec(v)
        }}
        onCommodity={(v) => {
          noteEdit()
          setCommodity(v)
        }}
        onPickupIds={(next) => {
          noteEdit()
          const r = reconcileHaulStops(next, dropoffIds, 'pickup')
          setPickupIds(r.pickupIds)
          setDropoffIds(r.dropoffIds)
        }}
        onDropoffIds={(next) => {
          noteEdit()
          const r = reconcileHaulStops(pickupIds, next, 'dropoff')
          setPickupIds(r.pickupIds)
          setDropoffIds(r.dropoffIds)
        }}
        primaryLabel="Save changes"
        primaryDisabled={scanBusy || codeInvalid}
        onPrimary={() => {
          if (codeInvalid || !pickupIds.length || !dropoffIds.length) return
          const from = locationLabel(pickupIds[0])
          const to = locationLabel(dropoffIds[dropoffIds.length - 1])
          onSave(
            createMission({
              id: mission.id,
              code: code.trim().slice(0, 5) || mission.code,
              name:
                name.trim() ||
                buildAutoMissionName({
                  giver,
                  rank,
                  haulType,
                  from,
                  to,
                  pickupCount: pickupIds.length,
                  dropoffCount: dropoffIds.length,
                  demo:
                    mission.source === 'demo' ||
                    name.trim().startsWith('(DEMO)'),
                }) ||
                `Haul ${totalScu} SCU → ${to}`,
              haulType,
              rank: rank.trim() || undefined,
              giver: giver.trim() || undefined,
              pickupIds,
              dropoffIds,
              totalScu: Math.max(1, totalScu),
              maxUnitScu: normalizeCrateSize(maxUnitScu),
              rewardAuec: rewardAuec || undefined,
              commodity: commodity.trim() || undefined,
              source: ocrFill ? 'ocr' : mission.source,
              priorPickups: mission.pickups,
            }),
          )
        }}
        onCancel={onCancel}
        registerPrimary={registerPrimary}
      />
    </>
  )
}

function MissionForm({
  idPrefix,
  haulType,
  giver,
  rank,
  showGiver,
  totalScu,
  maxUnitScu,
  rewardAuec,
  commodity,
  pickupIds,
  dropoffIds,
  locations,
  commodities,
  givers,
  onHaulType,
  onGiver,
  onRank,
  onTotalScu,
  onMaxUnitScu,
  onRewardAuec,
  onCommodity,
  onPickupIds,
  onDropoffIds,
  primaryLabel,
  primaryDisabled,
  onPrimary,
  onCancel,
  cancelLabel = 'Cancel',
  registerPrimary,
  batchNav,
}: {
  idPrefix: string
  haulType: HaulType
  giver: string
  rank: string
  showGiver: boolean
  totalScu: number
  maxUnitScu: number
  rewardAuec: number
  commodity: string
  pickupIds: string[]
  dropoffIds: string[]
  locations: Location[]
  commodities: CommodityInfo[]
  givers: string[]
  onHaulType: (v: HaulType) => void
  onGiver: (v: string) => void
  onRank: (v: string) => void
  onTotalScu: (v: number) => void
  onMaxUnitScu: (v: number) => void
  onRewardAuec: (v: number) => void
  onCommodity: (v: string) => void
  onPickupIds: (v: string[]) => void
  onDropoffIds: (v: string[]) => void
  primaryLabel: string
  primaryDisabled?: boolean
  onPrimary: () => void
  onCancel: () => void
  cancelLabel?: string
  registerPrimary?: (api: HeaderPrimary | null) => void
  batchNav?: {
    index: number
    total: number
    ready: number
    onPrev: () => void
    onNext: () => void
  }
}) {
  const onPrimaryRef = useRef(onPrimary)
  onPrimaryRef.current = onPrimary
  const primaryDisabledNow =
    Boolean(primaryDisabled) || !pickupIds.length || !dropoffIds.length

  useEffect(() => {
    if (!registerPrimary) return
    registerPrimary({
      run: () => onPrimaryRef.current(),
      disabled: primaryDisabledNow,
      label: primaryLabel,
    })
    return () => registerPrimary(null)
  }, [registerPrimary, primaryDisabledNow, primaryLabel])

  return (
    <div className="mission-modal-form">
      <div className="field-row field-row-giver-haul">
        {showGiver ? (
          <GiverPicker
            idPrefix={`${idPrefix}-giver`}
            givers={givers}
            value={giver}
            onChange={onGiver}
          />
        ) : (
          <span className="field field-spacer" aria-hidden />
        )}
        <RankPicker
          idPrefix={`${idPrefix}-rank`}
          value={rank}
          onChange={onRank}
        />
        <HaulTypePicker
          idPrefix={`${idPrefix}-haul`}
          value={haulType}
          onChange={onHaulType}
        />
      </div>

      <div className="field-row">
        <label className="field">
          <span>Total SCU</span>
          <input
            type="number"
            min={1}
            value={totalScu}
            onChange={(e) => onTotalScu(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>Max crate</span>
          <select
            value={maxUnitScu}
            onChange={(e) => onMaxUnitScu(normalizeCrateSize(Number(e.target.value)))}
          >
            {CRATE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Reward</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={formatRewardDigits(rewardAuec)}
            onChange={(e) => onRewardAuec(parseRewardDigits(e.target.value))}
            placeholder="0"
          />
        </label>
      </div>

      <CommodityPicker
        idPrefix={idPrefix}
        commodities={commodities}
        value={commodity}
        onChange={onCommodity}
      />

      <LocationPicker
        legend="Pickups"
        idPrefix={`${idPrefix}p`}
        locations={locations}
        selectedIds={pickupIds}
        peerSelectedCount={dropoffIds.length}
        max={MAX_HAUL_STOPS}
        onChange={onPickupIds}
      />

      <LocationPicker
        legend="Dropoffs"
        idPrefix={`${idPrefix}d`}
        locations={locations}
        selectedIds={dropoffIds}
        peerSelectedCount={pickupIds.length}
        max={MAX_HAUL_STOPS}
        onChange={onDropoffIds}
      />

      {batchNav && (
        <div className="ocr-batch-nav ocr-batch-nav-bottom">
          <button
            type="button"
            className="ghost"
            disabled={batchNav.index <= 0}
            onClick={batchNav.onPrev}
          >
            Prev
          </button>
          <span className="ocr-batch-label">
            Image {batchNav.index + 1} of {batchNav.total}
            {batchNav.ready < batchNav.total ? ` · ${batchNav.ready} ready` : ''}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={batchNav.index >= batchNav.ready - 1}
            onClick={batchNav.onNext}
          >
            Next
          </button>
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className="primary"
          disabled={primaryDisabledNow}
          onClick={onPrimary}
        >
          {primaryLabel}
        </button>
      </div>
    </div>
  )
}

function TitleMarquee({
  text,
  onDoubleClick,
}: {
  text: string
  onDoubleClick: () => void
}) {
  const clipRef = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const el = clipRef.current
    if (!el) return
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 2)
    check()
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [text])

  return (
    <div
      ref={clipRef}
      className={`mission-title-marquee${overflow ? ' is-overflow' : ''}`}
      title={`${text} — double-click to edit`}
      onDoubleClick={onDoubleClick}
      role="presentation"
    >
      <span className="mission-title-marquee-text">{text}</span>
      {overflow ? (
        <span className="mission-title-marquee-text" aria-hidden>
          {text}
        </span>
      ) : null}
    </div>
  )
}

