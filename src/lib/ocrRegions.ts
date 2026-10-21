import type { OcrRegionId, OcrRegionMap, OcrRegionRect } from '../types'

/** Layout used for OCR runs (last Save / Mark as default). */
const ACTIVE_KEY = 'sc-hauling-ocr-regions-active-v3'
/** Personal default — “Mark as default”. */
const DEFAULT_KEY = 'sc-hauling-ocr-regions-default-v3'
const LEGACY_KEY = 'sc-hauling-ocr-regions-v3'

export const DEFAULT_OCR_REGIONS: OcrRegionMap = {
  title: { x: 0.3, y: 0.06, w: 0.66, h: 0.14 },
  reward: { x: 0.72, y: 0.21, w: 0.24, h: 0.06 },
  giver: { x: 0.3, y: 0.21, w: 0.4, h: 0.06 },
  info: { x: 0.3, y: 0.29, w: 0.66, h: 0.18 },
  objectives: { x: 0.3, y: 0.5, w: 0.66, h: 0.4 },
}

export const OCR_REGION_LABELS: Record<OcrRegionId, string> = {
  title: 'Mission title',
  reward: 'Reward',
  giver: 'Giver',
  info: 'Mission info',
  objectives: 'Objectives',
}

export const OCR_REGION_IDS: OcrRegionId[] = [
  'title',
  'reward',
  'giver',
  'info',
  'objectives',
]

const MIN_SIZE = 0.04

export function clampRect(r: OcrRegionRect): OcrRegionRect {
  let w = Math.min(1, Math.max(MIN_SIZE, Number(r.w) || MIN_SIZE))
  let h = Math.min(1, Math.max(MIN_SIZE, Number(r.h) || MIN_SIZE))
  let x = Number(r.x) || 0
  let y = Number(r.y) || 0

  if (x + w > 1) x = 1 - w
  if (y + h > 1) y = 1 - h
  x = Math.max(0, Math.min(x, 1 - MIN_SIZE))
  y = Math.max(0, Math.min(y, 1 - MIN_SIZE))
  w = Math.min(Math.max(MIN_SIZE, w), 1 - x)
  h = Math.min(Math.max(MIN_SIZE, h), 1 - y)
  return { x, y, w, h }
}

export function clampRegionMap(regions: OcrRegionMap): OcrRegionMap {
  const out = { ...DEFAULT_OCR_REGIONS }
  for (const id of OCR_REGION_IDS) {
    out[id] = clampRect(regions[id] ?? DEFAULT_OCR_REGIONS[id])
  }
  return out
}

function parseStored(raw: string): OcrRegionMap | null {
  try {
    const parsed = JSON.parse(raw) as Partial<OcrRegionMap> & Record<string, OcrRegionRect>
    const out = { ...DEFAULT_OCR_REGIONS }
    let any = false
    for (const id of OCR_REGION_IDS) {
      const rect = parsed[id] ?? (id === 'title' ? parsed.header : undefined)
      if (rect) {
        out[id] = clampRect(rect)
        any = true
      }
    }
    return any ? out : null
  } catch {
    return null
  }
}

function readKey(key: string): OcrRegionMap | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    return parseStored(raw)
  } catch {
    return null
  }
}

function writeKey(key: string, regions: OcrRegionMap): void {
  localStorage.setItem(key, JSON.stringify(clampRegionMap(regions)))
}

function migrateLegacyOnce(): void {
  if (readKey(ACTIVE_KEY) || readKey(DEFAULT_KEY)) return
  const legacy = readKey(LEGACY_KEY)
  if (!legacy) return
  writeKey(ACTIVE_KEY, legacy)
  writeKey(DEFAULT_KEY, legacy)
}

migrateLegacyOnce()

export function loadOcrRegions(): OcrRegionMap {
  return (
    readKey(DEFAULT_KEY) ??
    readKey(ACTIVE_KEY) ??
    { ...DEFAULT_OCR_REGIONS }
  )
}

export function loadMarkedDefaultRegions(): OcrRegionMap | null {
  return readKey(DEFAULT_KEY)
}

export function hasMarkedDefaultRegions(): boolean {
  return readKey(DEFAULT_KEY) != null
}

export function getEditorStartRegions(): OcrRegionMap {
  return (
    loadMarkedDefaultRegions() ??
    readKey(ACTIVE_KEY) ??
    { ...DEFAULT_OCR_REGIONS }
  )
}

export function saveOcrRegions(regions: OcrRegionMap): void {
  writeKey(ACTIVE_KEY, regions)
}

export function markOcrRegionsAsDefault(regions: OcrRegionMap): void {
  const clean = clampRegionMap(regions)
  writeKey(DEFAULT_KEY, clean)
  writeKey(ACTIVE_KEY, clean)
}

type CropEnhance = 'none' | 'invert' | 'ink' | 'blue' | 'blueMask'

function isUiBlue(r: number, g: number, b: number): boolean {
  // SC contract “N SCU” accent — cyan/blue, not white/gray chrome
  return b > 88 && b >= r + 22 && b >= g + 8 && b - Math.min(r, g) > 18
}

/**
 * Continuous grayscale — no hard 0/255 cut (that caused 6/8/9 swaps).
 * invert: white UI text → dark ink
 * blue: blue crate “N SCU” → dark ink (helps 8 not read as 4)
 */
function softEnhance(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  mode: 'invert' | 'blue',
): void {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    let bright = lum
    if (mode === 'blue') {
      const blueExcess = Math.max(0, b - (r + g) / 2)
      bright = Math.max(lum * 0.35, blueExcess * 2.4 + b * 0.2)
    }
    const v = Math.max(0, Math.min(255, Math.round(255 - bright)))
    d[i] = v
    d[i + 1] = v
    d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * White UI glyphs → dark ink; dark holes stay white.
 * Full invert fills the gap in “9” so Tesseract reads “8”.
 */
function whiteInkEnhance(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    let v = 255
    if (lum > 125) {
      v = Math.max(0, Math.min(255, Math.round(255 - (lum - 125) * 2.4)))
    }
    d[i] = v
    d[i + 1] = v
    d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

/** Hard mask: only blue pixels → black ink on white (isolates max-crate “N SCU”). */
function blueMaskEnhance(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const v = isUiBlue(d[i], d[i + 1], d[i + 2]) ? 0 : 255
    d[i] = v
    d[i + 1] = v
    d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * Crop info region down to the blue-ink bounding box, then upscale.
 * Returns null when too little blue is present.
 */
export async function cropBlueScuBlob(
  source: ImageBitmap | HTMLImageElement,
  rect: OcrRegionRect,
  opts?: { minEdge?: number },
): Promise<Blob | null> {
  const r = clampRect(rect)
  const srcW = 'width' in source ? source.width : (source as HTMLImageElement).naturalWidth
  const srcH = 'height' in source ? source.height : (source as HTMLImageElement).naturalHeight
  const sx = Math.floor(r.x * srcW)
  const sy = Math.floor(r.y * srcH)
  const sw = Math.max(1, Math.min(srcW - sx, Math.floor(r.w * srcW)))
  const sh = Math.max(1, Math.min(srcH - sy, Math.floor(r.h * srcH)))

  const probe = document.createElement('canvas')
  probe.width = sw
  probe.height = sh
  const pctx = probe.getContext('2d', { willReadFrequently: true })!
  pctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, sw, sh)
  const img = pctx.getImageData(0, 0, sw, sh)
  const d = img.data

  let minX = sw
  let minY = sh
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4
      if (!isUiBlue(d[i], d[i + 1], d[i + 2])) continue
      count++
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (count < 40 || maxX < minX || maxY < minY) return null

  const padX = Math.max(4, Math.round((maxX - minX) * 0.2))
  const padY = Math.max(4, Math.round((maxY - minY) * 0.35))
  const bx = Math.max(0, minX - padX)
  const by = Math.max(0, minY - padY)
  const bw = Math.min(sw - bx, maxX - minX + 1 + padX * 2)
  const bh = Math.min(sh - by, maxY - minY + 1 + padY * 2)

  const target = opts?.minEdge ?? 280
  const scale = Math.max(2, target / Math.min(bw, bh))
  const dw = Math.max(1, Math.round(bw * scale))
  const dh = Math.max(1, Math.round(bh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, dw, dh)
  ctx.drawImage(probe, bx, by, bw, bh, 0, 0, dw, dh)
  blueMaskEnhance(ctx, dw, dh)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Blue blob crop failed'))),
      'image/png',
    )
  })
}

/**
 * Plain crop + mild upscale. Optional soft enhance for reward/info digits.
 * Reward uses nearest-neighbor — bilinear blur turns “9” into “8”.
 */
export async function cropImageRegion(
  source: ImageBitmap | HTMLImageElement,
  rect: OcrRegionRect,
  regionId?: OcrRegionId,
  opts?: { enhance?: CropEnhance; minEdge?: number; smooth?: boolean },
): Promise<Blob> {
  const r = clampRect(rect)
  const srcW = 'width' in source ? source.width : (source as HTMLImageElement).naturalWidth
  const srcH = 'height' in source ? source.height : (source as HTMLImageElement).naturalHeight
  const sx = Math.floor(r.x * srcW)
  const sy = Math.floor(r.y * srcH)
  const sw = Math.max(1, Math.min(srcW - sx, Math.floor(r.w * srcW)))
  const sh = Math.max(1, Math.min(srcH - sy, Math.floor(r.h * srcH)))

  const enhance = opts?.enhance ?? 'none'
  const target =
    opts?.minEdge ??
    (regionId === 'reward' || regionId === 'info' ? 520 : 400)
  const scale = Math.max(1, target / Math.min(sw, sh))
  const dw = Math.max(1, Math.round(sw * scale))
  const dh = Math.max(1, Math.round(sh * scale))

  const smooth = opts?.smooth ?? regionId !== 'reward'
  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d', { willReadFrequently: enhance !== 'none' })!
  ctx.imageSmoothingEnabled = smooth
  if (smooth) ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, dw, dh)
  ctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, 0, 0, dw, dh)

  if (enhance === 'invert' || enhance === 'blue') softEnhance(ctx, dw, dh, enhance)
  else if (enhance === 'ink') whiteInkEnhance(ctx, dw, dh)
  else if (enhance === 'blueMask') blueMaskEnhance(ctx, dw, dh)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Crop failed'))),
      'image/png',
    )
  })
}
