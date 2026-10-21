import { useEffect, useRef, useState } from 'react'
import type { OcrRegionId, OcrRegionMap, OcrRegionRect } from '../types'
import {
  DEFAULT_OCR_REGIONS,
  OCR_REGION_IDS,
  OCR_REGION_LABELS,
  clampRect,
  clampRegionMap,
  getEditorStartRegions,
  hasMarkedDefaultRegions,
  loadMarkedDefaultRegions,
  markOcrRegionsAsDefault,
  saveOcrRegions,
} from '../lib/ocrRegions'
import { loadOcrSampleFile, saveOcrSampleFile } from '../lib/ocrSampleImage'

const COLORS: Record<OcrRegionId, string> = {
  title: '#5b9fd4',
  reward: '#d4a15b',
  giver: '#48b46e',
  info: '#9b7ed4',
  objectives: '#c45b8c',
}

/** 100% = section width; cannot zoom out below fit (would show empty edges). */
const ZOOM_MIN = 1
const ZOOM_MAX = 4
const ZOOM_STEP = 0.25

type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const RESIZE_HANDLES: ResizeHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

interface Props {
  /** modal = overlay dialog; embedded = inline in OCR import */
  variant?: 'modal' | 'embedded'
  onClose?: () => void
}

/** Keep the scaled image covering the viewport — no empty gutters from pan. */
function clampPanToFill(
  pan: { x: number; y: number },
  zoom: number,
  viewW: number,
  viewH: number,
  imgW: number,
  imgH: number,
): { x: number; y: number } {
  if (viewW < 1 || viewH < 1 || imgW < 1 || imgH < 1) return { x: 0, y: 0 }
  const sw = imgW * zoom
  const sh = imgH * zoom
  let x = pan.x
  let y = pan.y
  if (sw <= viewW) {
    x = (viewW - sw) / 2
  } else {
    x = Math.min(0, Math.max(viewW - sw, x))
  }
  if (sh <= viewH) {
    y = 0
  } else {
    y = Math.min(0, Math.max(viewH - sh, y))
  }
  return { x, y }
}

function resizeFromHandle(
  orig: OcrRegionRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): OcrRegionRect {
  let { x, y, w, h } = orig
  if (handle.includes('e')) w = orig.w + dx
  if (handle.includes('w')) {
    x = orig.x + dx
    w = orig.w - dx
  }
  if (handle.includes('s')) h = orig.h + dy
  if (handle.includes('n')) {
    y = orig.y + dy
    h = orig.h - dy
  }
  return clampRect({ x, y, w, h })
}

/** Normalized image coords (0–1) of the active resize handle. */
function handlePoint(box: OcrRegionRect, handle: ResizeHandle): { x: number; y: number } {
  const right = box.x + box.w
  const bottom = box.y + box.h
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  switch (handle) {
    case 'nw':
      return { x: box.x, y: box.y }
    case 'n':
      return { x: cx, y: box.y }
    case 'ne':
      return { x: right, y: box.y }
    case 'e':
      return { x: right, y: cy }
    case 'se':
      return { x: right, y: bottom }
    case 's':
      return { x: cx, y: bottom }
    case 'sw':
      return { x: box.x, y: bottom }
    case 'w':
      return { x: box.x, y: cy }
  }
}

export function OcrRegionSetup({ variant = 'modal', onClose }: Props) {
  const [regions, setRegions] = useState<OcrRegionMap>(() =>
    clampRegionMap(getEditorStartRegions()),
  )
  const [active, setActive] = useState<OcrRegionId>('title')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [hasDefault, setHasDefault] = useState(() => hasMarkedDefaultRegions())
  const [status, setStatus] = useState('')
  const [resizePx, setResizePx] = useState<{
    w: number
    h: number
    hx: number
    hy: number
  } | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const regionDrag = useRef<{
    mode: 'move' | 'resize'
    handle?: ResizeHandle
    startX: number
    startY: number
    orig: OcrRegionMap[OcrRegionId]
  } | null>(null)
  const panDrag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  function measureAndClampPan(
    nextPan: { x: number; y: number },
    nextZoom = zoom,
  ): { x: number; y: number } {
    const view = viewportRef.current
    const img = imgRef.current
    if (!view || !img) return nextPan
    return clampPanToFill(
      nextPan,
      nextZoom,
      view.clientWidth,
      view.clientHeight,
      img.offsetWidth,
      img.offsetHeight,
    )
  }

  function naturalSize() {
    const img = imgRef.current
    if (!img) return { nw: 0, nh: 0 }
    return {
      nw: img.naturalWidth || img.offsetWidth,
      nh: img.naturalHeight || img.offsetHeight,
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const blob = await loadOcrSampleFile()
      if (cancelled || !blob) return
      const url = URL.createObjectURL(blob)
      if (cancelled) {
        URL.revokeObjectURL(url)
        return
      }
      setPreviewUrl(url)
      setZoom(1)
      setPan({ x: 0, y: 0 })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  // Separate popup: lock page / parent modal scroll while open
  useEffect(() => {
    if (variant !== 'modal') return
    const prevOverflow = document.body.style.overflow
    document.body.classList.add('modal-open')
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow || 'hidden'
      document.body.classList.add('modal-open')
    }
  }, [variant])

  // Prevent browser auto-scroll on middle-click
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const block = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    }
    el.addEventListener('mousedown', block)
    el.addEventListener('auxclick', block)
    return () => {
      el.removeEventListener('mousedown', block)
      el.removeEventListener('auxclick', block)
    }
  }, [previewUrl])

  function onFile(file: File | null) {
    if (!file) return
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(URL.createObjectURL(file))
    setZoom(1)
    setPan({ x: 0, y: 0 })
    void saveOcrSampleFile(file)
  }

  function clampZoom(z: number) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
  }

  function zoomBy(delta: number) {
    setZoom((z) => {
      const next = clampZoom(Math.round((z + delta) / ZOOM_STEP) * ZOOM_STEP)
      setPan((p) => measureAndClampPan(p, next))
      return next
    })
  }

  function onStageWheel(e: React.WheelEvent) {
    if (!previewUrl) return
    e.preventDefault()
    zoomBy(e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
  }

  useEffect(() => {
    if (!previewUrl) return
    const apply = () => setPan((p) => measureAndClampPan(p, zoom))
    apply()
    const img = imgRef.current
    const onLoad = () => apply()
    if (img) img.addEventListener('load', onLoad)
    const view = viewportRef.current
    let ro: ResizeObserver | undefined
    if (view && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(apply)
      ro.observe(view)
    }
    return () => {
      img?.removeEventListener('load', onLoad)
      ro?.disconnect()
    }
  }, [previewUrl, zoom])

  function startPan(e: React.PointerEvent) {
    regionDrag.current = null
    setResizePx(null)
    panDrag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    viewportRef.current?.setPointerCapture(e.pointerId)
  }

  function onMoveDown(e: React.PointerEvent, id: OcrRegionId) {
    if (e.button === 1) {
      e.preventDefault()
      e.stopPropagation()
      startPan(e)
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setActive(id)
    setStatus('')
    setResizePx(null)
    panDrag.current = null
    regionDrag.current = {
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...regions[id] },
    }
    viewportRef.current?.setPointerCapture(e.pointerId)
  }

  function onResizeDown(e: React.PointerEvent, id: OcrRegionId, handle: ResizeHandle) {
    if (e.button === 1) {
      e.preventDefault()
      e.stopPropagation()
      startPan(e)
      return
    }
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setActive(id)
    setStatus('')
    panDrag.current = null
    const orig = { ...regions[id] }
    regionDrag.current = {
      mode: 'resize',
      handle,
      startX: e.clientX,
      startY: e.clientY,
      orig,
    }
    const { nw, nh } = naturalSize()
    const box = clampRect(orig)
    const pt = handlePoint(box, handle)
    setResizePx({
      w: Math.round(box.w * nw),
      h: Math.round(box.h * nh),
      hx: Math.round(pt.x * nw),
      hy: Math.round(pt.y * nh),
    })
    viewportRef.current?.setPointerCapture(e.pointerId)
  }

  function onPanDown(e: React.PointerEvent) {
    if (!previewUrl) return
    const isMiddle = e.button === 1
    const isLeftEmpty =
      e.button === 0 && !(e.target as HTMLElement).closest('.ocr-region-box')
    if (!isMiddle && !isLeftEmpty) return
    e.preventDefault()
    startPan(e)
  }

  function onPointerMove(e: React.PointerEvent) {
    if (panDrag.current) {
      const next = {
        x: panDrag.current.panX + (e.clientX - panDrag.current.x),
        y: panDrag.current.panY + (e.clientY - panDrag.current.y),
      }
      setPan(measureAndClampPan(next, zoom))
      return
    }
    if (!regionDrag.current || !imgRef.current) return
    const layoutW = imgRef.current.offsetWidth
    const layoutH = imgRef.current.offsetHeight
    if (layoutW < 1 || layoutH < 1) return
    const dx = (e.clientX - regionDrag.current.startX) / (layoutW * zoom)
    const dy = (e.clientY - regionDrag.current.startY) / (layoutH * zoom)
    const o = regionDrag.current.orig
    const drag = regionDrag.current

    setRegions((prev) => {
      const next = { ...prev }
      if (drag.mode === 'move') {
        next[active] = clampRect({
          ...o,
          x: o.x + dx,
          y: o.y + dy,
        })
      } else if (drag.handle) {
        next[active] = resizeFromHandle(o, drag.handle, dx, dy)
      }
      return next
    })

    if (drag.mode === 'resize' && drag.handle) {
      const box = resizeFromHandle(o, drag.handle, dx, dy)
      const { nw, nh } = naturalSize()
      const pt = handlePoint(box, drag.handle)
      setResizePx({
        w: Math.round(box.w * nw),
        h: Math.round(box.h * nh),
        hx: Math.round(pt.x * nw),
        hy: Math.round(pt.y * nh),
      })
    }
  }

  function onPointerUp() {
    regionDrag.current = null
    panDrag.current = null
    setResizePx(null)
  }

  function markDefault() {
    const clamped = clampRegionMap(regions)
    setRegions(clamped)
    markOcrRegionsAsDefault(clamped)
    setHasDefault(true)
    setStatus('Marked as default — used for OCR and when reopening setup')
  }

  function save() {
    const clamped = clampRegionMap(regions)
    setRegions(clamped)
    saveOcrRegions(clamped)
    if (hasDefault) markOcrRegionsAsDefault(clamped)
    setStatus('Regions saved for OCR')
    if (variant === 'modal') onClose?.()
  }

  function resetToDefault() {
    const marked = loadMarkedDefaultRegions()
    if (marked) {
      setRegions(clampRegionMap(marked))
      setStatus('Restored your marked default')
    } else {
      setRegions(clampRegionMap(DEFAULT_OCR_REGIONS))
      setStatus('No marked default — factory layout')
    }
  }

  const invZoom = 1 / zoom

  const body = (
    <>
      {variant === 'modal' && (
        <div className="panel-head">
          <h2 id="ocr-regions-title">OCR detection regions</h2>
          {onClose && (
            <button type="button" className="ghost" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      )}
      {variant === 'embedded' && (
        <h3 id="ocr-regions-title" className="ocr-regions-embedded-title">
          Detection regions
        </h3>
      )}
      <p className="hint tight">
        <strong>Mark as default</strong> stores the layout used when you reopen this setup.{' '}
        <strong>Save regions</strong> applies the layout to OCR. They are separate.
      </p>
      {status && <p className="ocr-status">{status}</p>}

      <label className="field">
        <span>Calibration screenshot{previewUrl ? ' (restored)' : ''}</span>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <div className="ocr-region-tools">
        {OCR_REGION_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={active === id ? 'chip on' : 'chip'}
            style={{ borderColor: COLORS[id] }}
            onClick={() => setActive(id)}
          >
            {OCR_REGION_LABELS[id]}
          </button>
        ))}
        <button type="button" className="ghost" onClick={resetToDefault}>
          {hasDefault ? 'Reset to default' : 'Factory layout'}
        </button>
      </div>

      {previewUrl && (
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
            Reset view
          </button>
          <span className="hint tight">
            Middle-click drag to pan · scroll to zoom · resize from any edge/corner
          </span>
        </div>
      )}

      <div
        ref={viewportRef}
        className="ocr-region-stage ocr-region-viewport"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onStageWheel}
        onPointerDown={onPanDown}
        onAuxClick={(e) => {
          if (e.button === 1) e.preventDefault()
        }}
      >
        {previewUrl ? (
          <div
            className="ocr-region-world"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            }}
          >
            <div className="ocr-region-frame">
              <img
                ref={imgRef}
                src={previewUrl}
                alt="Contract screenshot"
                draggable={false}
              />
              <div className="ocr-region-overlay">
                {OCR_REGION_IDS.map((id) => {
                  const box = clampRect(regions[id])
                  const showSize = active === id && resizePx
                  return (
                    <div
                      key={id}
                      className={`ocr-region-box${active === id ? ' active' : ''}`}
                      style={{
                        left: `${box.x * 100}%`,
                        top: `${box.y * 100}%`,
                        width: `${box.w * 100}%`,
                        height: `${box.h * 100}%`,
                        borderColor: COLORS[id],
                        color: COLORS[id],
                        background: `${COLORS[id]}22`,
                      }}
                      onPointerDown={(e) => onMoveDown(e, id)}
                    >
                      <span
                        className="ocr-region-label"
                        style={{
                          transform: `scale(${invZoom})`,
                          transformOrigin: 'top left',
                        }}
                      >
                        {OCR_REGION_LABELS[id]}
                      </span>
                      {showSize && (
                        <span
                          className="ocr-region-size"
                          style={{
                            transform: `scale(${invZoom})`,
                            transformOrigin: 'bottom left',
                          }}
                        >
                          {resizePx.w} × {resizePx.h} px
                          <br />
                          {resizePx.hx}, {resizePx.hy}
                        </span>
                      )}
                      {active === id &&
                        RESIZE_HANDLES.map((handle) => (
                          <i
                            key={handle}
                            className={`ocr-region-handle ocr-region-handle-${handle}`}
                            style={{
                              transform: `scale(${invZoom})`,
                            }}
                            onPointerDown={(e) => onResizeDown(e, id, handle)}
                          />
                        ))}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        ) : (
          <p className="empty">Drop or choose a screenshot to position the regions.</p>
        )}
      </div>

      <div className={variant === 'modal' ? 'modal-actions' : 'ocr-region-actions'}>
        {variant === 'modal' && onClose && (
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
        )}
        <button type="button" className="ghost" onClick={markDefault}>
          Mark as default
        </button>
        <button type="button" className="primary" onClick={save}>
          Save regions
        </button>
      </div>
    </>
  )

  if (variant === 'embedded') {
    return (
      <div className="ocr-region-embedded" aria-labelledby="ocr-regions-title">
        {body}
      </div>
    )
  }

  return (
    <div
      className="modal-backdrop ocr-region-backdrop"
      role="presentation"
      onClick={() => onClose?.()}
      onWheel={(e) => e.preventDefault()}
    >
      <div
        className="modal panel ocr-region-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ocr-regions-title"
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </div>
    </div>
  )
}
