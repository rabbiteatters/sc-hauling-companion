/**
 * Contract OCR — region crops + full-image fallback.
 * Keep parsing simple; no digit “fixes” that corrupt 6/8/9.
 */
import { createWorker, PSM } from 'tesseract.js'
import {
  getAllLocations,
  getNyxGatewayPyro,
  matchOcrLocationName,
  createLocationResolveCtx,
  resolveContractLocation,
} from '../store/catalog'
import type { HaulType, Mission, OcrRegionMap } from '../types'
import {
  DEFAULT_HAUL_TYPE,
  inferHaulType,
  parseHaulRank,
  parseHaulType,
} from './haulTypes'
import {
  parseDeliverTotalScu,
  parseGiverName,
  parseRewardAmount,
  parseRewardAmountFromFull,
  pickBestRewardText,
  pickMaxCrateSize,
  reconstructHaulTitle,
} from './ocrEnhance'
import {
  clampRegionMap,
  cropBlueScuBlob,
  cropImageRegion,
  loadOcrRegions,
  OCR_REGION_IDS,
  OCR_REGION_LABELS,
} from './ocrRegions'
import { DEFAULT_MAX_UNIT_SCU, createMission } from './spread'

export interface OcrProgress {
  status: string
  progress: number
}

export interface OcrRegionTexts {
  title: string
  reward: string
  giver: string
  info: string
  objectives: string
  full: string
}

type TessWorker = Awaited<ReturnType<typeof createWorker>>

/**
 * Reward crop is already large enough for icon + amount.
 * Run sharp + smooth + ink passes; if they only disagree on 8↔9, keep the 9.
 */
async function readRewardRegion(
  worker: TessWorker,
  bitmap: ImageBitmap,
  rect: Parameters<typeof cropImageRegion>[1],
): Promise<string> {
  const tryCrop = async (
    enhance: 'none' | 'ink',
    smooth: boolean,
  ) => {
    const blob = await cropImageRegion(bitmap, rect, 'reward', {
      enhance,
      minEdge: 480,
      smooth,
    })
    try {
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789,. ',
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
      })
      const { data } = await worker.recognize(blob)
      return (data.text ?? '').trim()
    } finally {
      await worker.setParameters({
        tessedit_char_whitelist: '',
        tessedit_pageseg_mode: PSM.AUTO,
      })
    }
  }

  // Img4 needs sharp; img3 often needs smooth — vote when they only differ by 8↔9
  const candidates = [
    await tryCrop('none', false),
    await tryCrop('none', true),
    await tryCrop('ink', false),
  ]
  return pickBestRewardText(candidates)
}

async function ocrDigitsScu(worker: TessWorker, blob: Blob): Promise<string> {
  try {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789BbSCUscu ',
    })
    const { data } = await worker.recognize(blob)
    return (data.text ?? '').trim()
  } finally {
    await worker.setParameters({ tessedit_char_whitelist: '' })
  }
}

/**
 * Info / max crate: plain + soft-blue + blue-mask + blue-blob.
 * Blue “8 SCU” often reads as 4 unless isolated.
 */
async function readInfoRegion(
  worker: TessWorker,
  bitmap: ImageBitmap,
  rect: Parameters<typeof cropImageRegion>[1],
): Promise<{ display: string; plain: string; blue: string; mask: string; blob: string }> {
  const recognize = async (enhance: 'none' | 'blue' | 'blueMask', minEdge: number) => {
    const crop = await cropImageRegion(bitmap, rect, 'info', { enhance, minEdge })
    const { data } = await worker.recognize(crop)
    return (data.text ?? '').trim()
  }

  const plain = await recognize('none', 560)
  const blue = await recognize('blue', 560)
  const mask = await recognize('blueMask', 640)

  let blobText = ''
  try {
    const blob = await cropBlueScuBlob(bitmap, rect, { minEdge: 300 })
    if (blob) blobText = await ocrDigitsScu(worker, blob)
  } catch {
    blobText = ''
  }

  const display =
    /\d\s*scu/i.test(mask) || /[bB]\s*scu/i.test(mask)
      ? mask
      : /\d\s*scu/i.test(blobText)
        ? blobText
        : /\d\s*scu/i.test(blue)
          ? blue
          : plain || blue || mask || blobText
  return { display, plain, blue, mask, blob: blobText }
}

export async function readMissionImage(
  file: File | Blob,
  onProgress?: (p: OcrProgress) => void,
  regions?: OcrRegionMap,
): Promise<{ text: string; missions: Mission[]; regions: OcrRegionTexts }> {
  const map = clampRegionMap(regions ?? loadOcrRegions())
  const bitmap = await createImageBitmap(file)
  const worker = await createWorker('eng', 1, {
    logger: (m) => {
      if (m.status && typeof m.progress === 'number') {
        onProgress?.({ status: m.status, progress: m.progress })
      }
    },
  })

  try {
    const texts: OcrRegionTexts = {
      title: '',
      reward: '',
      giver: '',
      info: '',
      objectives: '',
      full: '',
    }

    // 1) Full image first — most reliable baseline
    onProgress?.({ status: 'Reading image…', progress: 0.05 })
    const fullResult = await worker.recognize(file)
    const fullText = (fullResult.data.text ?? '').trim()
    texts.full = fullText

    // Extra info texts for crate 4↔8 voting (not shown separately in preview)
    let infoPlain = ''
    let infoBlue = ''
    let infoMask = ''
    let infoBlob = ''

    // 2) Region crops — plain upscale; reward/info get soft enhance retries
    let step = 0
    for (const key of OCR_REGION_IDS) {
      onProgress?.({
        status: `Reading ${OCR_REGION_LABELS[key]}…`,
        progress: 0.15 + (step / OCR_REGION_IDS.length) * 0.75,
      })
      try {
        if (key === 'reward') {
          texts.reward = await readRewardRegion(worker, bitmap, map.reward)
        } else if (key === 'info') {
          const info = await readInfoRegion(worker, bitmap, map.info)
          texts.info = info.display
          infoPlain = info.plain
          infoBlue = info.blue
          infoMask = info.mask
          infoBlob = info.blob
        } else {
          const blob = await cropImageRegion(bitmap, map[key], key)
          const { data } = await worker.recognize(blob)
          texts[key] = (data.text ?? '').trim()
        }
      } catch {
        texts[key] = ''
      }
      step += 1
    }

    // Keep raw reward crop for preview (region already covers the full amount).
    // Parse falls back to full image only if the crop amount can’t be read.
    const merged: OcrRegionTexts = {
      title: texts.title,
      reward: texts.reward,
      giver: texts.giver,
      info: texts.info,
      objectives: texts.objectives,
      full: fullText,
    }

    const debugDump = [
      '--- FULL ---',
      fullText || '(empty)',
      ...OCR_REGION_IDS.map(
        (k) => `--- ${OCR_REGION_LABELS[k].toUpperCase()} ---\n${texts[k] || '(empty)'}`,
      ),
      `--- INFO PLAIN ---\n${infoPlain || '(empty)'}`,
      `--- INFO BLUE ---\n${infoBlue || '(empty)'}`,
      `--- INFO MASK ---\n${infoMask || '(empty)'}`,
      `--- INFO BLOB ---\n${infoBlob || '(empty)'}`,
    ].join('\n\n')

    let missions = parseRegionTexts(merged, {
      infoPlain,
      infoBlue,
      infoMask,
      infoBlob,
    })
    if (!missions.length && fullText) {
      missions = parseMissionText(fullText)
    }
    // Last resort: parse joined region+full dump
    if (!missions.length && (fullText || texts.objectives)) {
      missions = parseMissionText(
        [fullText, texts.title, texts.objectives, texts.info].filter(Boolean).join('\n'),
      )
    }

    bitmap.close()
    return { text: debugDump, missions, regions: merged }
  } finally {
    await worker.terminate()
  }
}

export type InfoOcrExtra = {
  infoPlain?: string
  infoBlue?: string
  infoMask?: string
  infoBlob?: string
}

export function parseRegionTexts(
  texts: OcrRegionTexts,
  infoExtra?: InfoOcrExtra,
): Mission[] {
  const fromRegions = parseStellarHaul(
    [texts.title, texts.reward, texts.giver, texts.info, texts.objectives].join('\n'),
    texts,
    infoExtra,
  )
  if (fromRegions) return [fromRegions]
  return parseMissionText(texts.full || texts.objectives)
}

export function parseMissionText(text: string): Mission[] {
  const cleaned = text.replace(/\r/g, '\n')
  const stellar = parseStellarHaul(cleaned)
  if (stellar) return [stellar]

  const missions: Mission[] = []
  for (const block of splitBlocks(cleaned)) {
    const parsed = parseBlock(block)
    if (parsed) missions.push(parsed)
  }
  return missions
}

const RE_COLLECT = /col+ect\s+(.+?)\s+from\s+(.+)/gi
const RE_ELEVATOR = /freight\s+elevator\s+at\s+(.+?)(?:\s+at\s+the|\s*$)/gi
const RE_FROM = /\bfrom\s+([A-Za-z][A-Za-z0-9\s'&.-]{2,40})/gi

/** Prefer catalog shortName for “| to Dest”; fall back to objectives dropoff. */
function alignTitleDestination(
  title: string | undefined,
  dropoffShortName: string,
): string | undefined {
  if (!title) return undefined
  const m = title.match(/^(.*?\|\s*to\s+)(.+)$/i)
  if (!m) {
    // Rank | Haul without dest — append resolved dropoff
    if (/\|/.test(title) && !/\bto\s+/i.test(title)) {
      return `${title} | to ${dropoffShortName}`
    }
    return title
  }
  const matched = matchOcrLocationName(m[2])
  return `${m[1]}${matched?.shortName ?? dropoffShortName}`
}

/** Prefer objectives crop when it has Deliver; otherwise full image. */
function objectivesText(regions: OcrRegionTexts | undefined, text: string): string {
  const full = regions?.full?.trim() || text
  const obj = regions?.objectives?.trim() || ''
  if (obj.length >= 24 && /del[il1]ver|\d+\s*\/\s*\d+\s*scu/i.test(obj)) return obj
  return full || obj || text
}

/** Objectives crop only — used for Nyx duplicate detection. */
function objectivesCropOnly(regions: OcrRegionTexts | undefined): string {
  return regions?.objectives?.trim() || ''
}

function cleanPlaceRaw(raw: string): string {
  return raw
    .replace(/\s+at\s+the\s+L\d.*/i, '')
    .replace(/\s+at\s+the\s+.*/i, '')
    .replace(/\s+above\s+.*/i, '')
    .replace(/\s+in\s+any\s+order.*/i, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[.\u2022©]+$/g, '')
    .trim()
}

/** Normalize place OCR for exact duplicate-name checks. */
function placeKey(raw: string): string {
  return cleanPlaceRaw(raw)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Collect place strings in order from objectives.
 * Keeps duplicate names (2nd “Checkmate” → Nyx). Does not use broad “from X”
 * alongside Collect lines (that caused false Nyx).
 */
function extractPickupRaws(objText: string): string[] {
  const raws: string[] = []
  const add = (raw: string) => {
    const cleaned = cleanPlaceRaw(raw)
    if (!cleaned || /^(any order|locations?)$/i.test(cleaned)) return
    if (!placeKey(cleaned)) return
    raws.push(cleaned)
  }

  for (const re of [RE_COLLECT, RE_ELEVATOR]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(objText)) !== null) {
      add(m[2] ?? m[1])
    }
  }
  if (!raws.length) {
    RE_FROM.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = RE_FROM.exec(objText)) !== null) {
      add(m[1])
    }
  }

  return raws
}

function findPickupsInText(
  objText: string,
  dropoffId: string,
  /** 2nd identical collect name → Nyx (objectives crop only). */
  nyxOnDuplicateCollect: boolean,
): string[] {
  const pickupIds: string[] = []
  const seenPlaceKeys = new Set<string>()
  const nyx = getNyxGatewayPyro()
  const ctx = createLocationResolveCtx({ nyxOnDuplicate: false })

  for (const raw of extractPickupRaws(objText)) {
    const key = placeKey(raw)
    // In-game quirk: same collect place listed twice → 2nd is Nyx Gateway (Pyro)
    if (nyxOnDuplicateCollect && key && seenPlaceKeys.has(key)) {
      if (nyx.id !== dropoffId && !pickupIds.includes(nyx.id)) {
        pickupIds.push(nyx.id)
      }
      continue
    }
    if (key) seenPlaceKeys.add(key)

    const loc = resolveContractLocation(raw, ctx)
    if (loc.id !== dropoffId && !pickupIds.includes(loc.id)) {
      pickupIds.push(loc.id)
    }
  }

  // Last resort: catalog names mentioned in objectives (excluding dropoff) — no Nyx
  if (!pickupIds.length) {
    const lower = objText.toLowerCase()
    for (const loc of getAllLocations()) {
      if (loc.id === dropoffId) continue
      const names = [loc.shortName, loc.name, ...(loc.aliases ?? [])]
      for (const name of names) {
        if (!name || name.length < 4) continue
        if (lower.includes(name.toLowerCase())) {
          if (!pickupIds.includes(loc.id)) pickupIds.push(loc.id)
          break
        }
      }
      if (pickupIds.length >= 6) break
    }
  }

  return pickupIds
}

function parseStellarHaul(
  text: string,
  regions?: OcrRegionTexts,
  infoExtra?: InfoOcrExtra,
): Mission | null {
  const fullFallback = regions?.full?.trim() || text
  const objText = objectivesText(regions, text)
  const titleText = regions?.title?.trim() || ''
  const rewardText = regions?.reward?.trim() || ''
  const giverText = regions?.giver?.trim() || ''
  const infoText = regions?.info?.trim() || ''

  const objectivesCrop = objectivesCropOnly(regions)
  const deliver =
    parseDeliverTotalScu(objectivesCrop) ??
    parseDeliverTotalScu(objText) ??
    parseDeliverTotalScu(fullFallback) ??
    parseDeliverTotalScu(text)
  if (!deliver) return null

  const { totalScu, commodity, dropRaw } = deliver
  const dropoff = resolveContractLocation(
    dropRaw,
    createLocationResolveCtx({ nyxOnDuplicate: false }),
  )

  // Nyx quirk: 2nd identical *collect* name in OBJECTIVES → Nyx Gateway (Pyro)
  const pickupIds: string[] = []
  if (objectivesCrop) {
    pickupIds.push(...findPickupsInText(objectivesCrop, dropoff.id, true))
  }
  if (!pickupIds.length) {
    const fallbackText =
      objectivesCrop && objectivesCrop !== fullFallback ? fullFallback : objText
    if (fallbackText && fallbackText !== objectivesCrop) {
      pickupIds.push(...findPickupsInText(fallbackText, dropoff.id, false))
    }
  }
  if (!pickupIds.length) return null

  const maxUnitScu =
    pickMaxCrateSize([
      { text: infoExtra?.infoBlob, loose: true, weight: 4 },
      { text: infoExtra?.infoMask, loose: true, weight: 3 },
      { text: infoExtra?.infoBlue, loose: true, weight: 2 },
      { text: infoExtra?.infoPlain, loose: true, weight: 1 },
      { text: infoText, loose: true, weight: 1 },
      // Full image: strict phrases only — loose “N SCU” is too noisy
      { text: fullFallback, loose: false, weight: 2 },
    ]) ?? DEFAULT_MAX_UNIT_SCU

  const reward =
    parseRewardAmount(rewardText) ?? parseRewardAmountFromFull(fullFallback)

  const rawTitle =
    reconstructHaulTitle(titleText) || reconstructHaulTitle(fullFallback)
  const name =
    alignTitleDestination(rawTitle, dropoff.shortName) ||
    `Stellar Haul | ${totalScu} SCU ${commodity} → ${dropoff.shortName}`

  const haulType: HaulType =
    parseHaulType(titleText || name) ??
    parseHaulType(name) ??
    inferHaulType(pickupIds.length, 1, name) ??
    DEFAULT_HAUL_TYPE

  const giver =
    parseGiverName(giverText, { regionCrop: true }) ??
    parseGiverName(fullFallback, { regionCrop: false })

  return createMission({
    name,
    haulType,
    rank: parseHaulRank(titleText || name),
    giver,
    commodity,
    totalScu,
    maxUnitScu,
    rewardAuec: reward,
    pickupIds,
    dropoffIds: [dropoff.id],
    source: 'ocr',
  })
}

function splitBlocks(text: string): string[] {
  const parts = text
    .split(/\n{2,}|-{3,}|_{3,}|=+/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 20)
  return parts.length ? parts : [text]
}

function parseBlock(block: string): Mission | null {
  const stellar = parseStellarHaul(block)
  if (stellar) return stellar

  const cargoMatch = block.match(/(\d+)\s*SCU/i)
  const totalScu = cargoMatch ? Number(cargoMatch[1]) : NaN
  if (!Number.isFinite(totalScu) || totalScu <= 0) return null

  const pickupRaw = block.match(/(?:pick\s*-?\s*up|from)[:\s]+([^\n|]+)/i)?.[1]
  const dropRaw = block.match(/(?:drop\s*-?\s*off|deliver(?:y)?|to)[:\s]+([^\n|]+)/i)?.[1]
  if (!pickupRaw || !dropRaw) return null

  const ctx = createLocationResolveCtx({ nyxOnDuplicate: false })
  const pickup = resolveContractLocation(
    pickupRaw.replace(/[|•·].*$/, '').trim(),
    ctx,
  )
  const dropoff = resolveContractLocation(
    dropRaw.replace(/[|•·].*$/, '').trim(),
    ctx,
  )
  if (pickup.id === dropoff.id) return null

  const name = `Haul ${totalScu} SCU → ${dropoff.shortName}`
  return createMission({
    name,
    haulType: parseHaulType(block) ?? inferHaulType(1, 1, name),
    pickupIds: [pickup.id],
    dropoffIds: [dropoff.id],
    totalScu,
    rewardAuec: parseRewardAmount(block),
    source: 'ocr',
  })
}
