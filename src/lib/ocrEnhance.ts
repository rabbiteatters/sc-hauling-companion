import { canonicalLocationLabel } from '../store/catalog'
import { HAUL_RANKS, HAUL_TYPES } from './haulTypes'
import { CRATE_SIZES, type CrateSize } from './spread'

function cleanGiverName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^[:\-–—]\s*/, '')
    .replace(/\s+(reward|auec|collect|deliver).*$/i, '')
    .trim()
    .slice(0, 60)
}

/**
 * Giver / org name. Never treats objective “Collect X from Y” as the giver.
 * Region crop: use the crop text itself when it looks like a name.
 */
export function parseGiverName(
  raw: string,
  opts: { regionCrop?: boolean } = {},
): string | undefined {
  const text = raw.replace(/\u00A0/g, ' ').trim()
  if (!text) return undefined

  // Explicit labels only — do NOT match bare “from” (objectives use that)
  const labeled = text.match(
    /(?:giver|offered\s+by|posted\s+by|contractor|organization|faction)[:\s]+([^\n|;]+)/i,
  )
  if (labeled) {
    const name = cleanGiverName(labeled[1])
    if (name) return name
  }

  if (!opts.regionCrop) return undefined

  // Giver crop is usually just the org/NPC name on one or two lines
  const line = text
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 1)
  if (!line) return undefined
  if (
    /^(collect|deliver|take|transport|reward|auec|mission|\d+\s*scu)\b/i.test(line) ||
    /\bfrom\b/i.test(line) ||
    /\bto\s+[A-Za-z]/i.test(line) ||
    /\|/.test(line)
  ) {
    return undefined
  }
  const name = cleanGiverName(line)
  return name.length >= 2 ? name : undefined
}

function isHaulTitleLine(line: string): boolean {
  return (
    HAUL_RANKS.some((r) => new RegExp(`\\b${r}\\b`, 'i').test(line)) ||
    HAUL_TYPES.some((h) => line.toLowerCase().includes(h.toLowerCase())) ||
    /\|\s*(?:local|planetary|stellar|interstellar)\b/i.test(line)
  )
}

/** 2nd title line is almost always “to Dest” (sometimes split / OCR-garbled). */
function isTitleDestLine(line: string): boolean {
  const t = line.replace(/^[|\s]+/, '').trim()
  if (!t) return false
  // Explicit “to …”
  if (/^to\s+[A-Za-z]/i.test(t)) return true
  // Leading pipe then place name
  if (/^\|\s*[A-Za-z]/.test(line) && t.split(/\s+/).length <= 8) return true
  // Bare destination after a haul line that ended with “|”
  if (
    /^[A-Za-z][A-Za-z0-9\s'&.-]{1,40}$/.test(t) &&
    t.split(/\s+/).length <= 6 &&
    !/^(collect|deliver|take|transport|reward|auec|mission|max)/i.test(t)
  ) {
    return true
  }
  return false
}

function cleanDest(raw: string): string {
  return raw
    .replace(/^to\s+/i, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s+(reward|auec|collect|deliver|take|transport|mission|max(?:imum)?).*$/i, '')
    .replace(/\s{2,}.*$/, '')
    .trim()
}

/** OCR dest text → catalog shortName when possible. */
function resolveDestLabel(raw: string): string {
  const cleaned = cleanDest(raw)
  if (!cleaned) return ''
  return canonicalLocationLabel(cleaned)
}

function extractDest(from: string): string {
  const m =
    from.match(/\|\s*to\s+([A-Za-z][A-Za-z0-9\s'&.-]{1,50})/i)?.[1] ||
    from.match(/(?:^|\s)to\s+([A-Za-z][A-Za-z0-9\s'&.-]{1,50})/i)?.[1]
  return m ? resolveDestLabel(m) : ''
}

/**
 * Rebuild haul title. Keeps rank/haul line + the following “to Dest” line
 * (SC titles wrap that way). Does not absorb description lines below.
 */
export function reconstructHaulTitle(raw: string): string | undefined {
  const lines = raw
    .replace(/\r/g, '\n')
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1)
  if (!lines.length) return undefined

  let start = lines.findIndex(isHaulTitleLine)
  if (start < 0) {
    const flatAll = lines.join(' ').replace(/\s+/g, ' ')
    const rank = HAUL_RANKS.find((r) => new RegExp(`\\b${r}\\b`, 'i').test(flatAll))
    const haul = HAUL_TYPES.find((h) => flatAll.toLowerCase().includes(h.toLowerCase()))
    if (!rank || !haul) return undefined
    const d = extractDest(flatAll)
    return d ? `${rank} | ${haul} | to ${d}` : `${rank} | ${haul}`
  }

  const kept = [lines[start]]
  // Always pull the next line when it is the wrapped “to Dest”
  if (start + 1 < lines.length && isTitleDestLine(lines[start + 1])) {
    kept.push(lines[start + 1])
  }
  // Rare: “| to” on line 2 and place name alone on line 3
  if (
    kept.length === 2 &&
    /to\s*$/i.test(kept[1]) &&
    start + 2 < lines.length &&
    isTitleDestLine(lines[start + 2])
  ) {
    kept.push(lines[start + 2])
  }

  const flat = kept.join(' ').replace(/\s+/g, ' ').replace(/\|\s*\|/g, '|').trim()

  const rank = HAUL_RANKS.find((r) => new RegExp(`\\b${r}\\b`, 'i').test(flat))
  const haul = HAUL_TYPES.find((h) => flat.toLowerCase().includes(h.toLowerCase()))
  let dest = extractDest(flat)

  // If “to” was lost by OCR on line 2, treat that line as the destination name
  if (!dest && kept.length >= 2) {
    const tail = kept
      .slice(1)
      .join(' ')
      .replace(/^[|\s]+/, '')
      .replace(/^to\s+/i, '')
      .trim()
    if (tail && isTitleDestLine(kept[1])) dest = resolveDestLabel(tail)
  }

  if (rank && haul) {
    return dest ? `${rank} | ${haul} | to ${dest}` : `${rank} | ${haul}`
  }

  return flat.slice(0, 120)
}

/** Drop cargo / progress digits so full-image reward parse doesn’t grab them. */
function scrubNonRewardNoise(raw: string): string {
  return raw
    .replace(/\u00A0/g, ' ')
    .replace(/\b\d+\s*\/\s*\d+\b/g, ' ')
    .replace(/\b\d+\s*scu\b/gi, ' ')
    .replace(
      /\b(?:max(?:imum)?|containers?|up\s+to|or\s+smaller)[^.\n]{0,48}/gi,
      ' ',
    )
}

/**
 * aUEC from reward crop.
 * Handles icon→“7” prefix (“7 958,250”); never loses that to a smaller full-image amount.
 */
export function parseRewardAmount(raw: string): number | undefined {
  if (!raw || !/\d/.test(raw)) return undefined

  let text = raw.replace(/\u00A0/g, ' ').replace(/[，、٫ʼ'`´]/g, ',')

  // 1) Strip heading-icon digit BEFORE normalizing spaces
  //    “7 958,250” → “958,250”  (must not become “7,958” first)
  text = text.replace(/\b\d\s+(?=\d{1,3}[,.\s]\d{3}\b)/g, '')
  text = text.replace(/\b\d,(?=\d{3},\d{3}\b)/g, '')

  // 2) Normalize thousands separators
  text = text
    .replace(/\b(\d{1,3})\.(\d{3})\b/g, '$1,$2')
    .replace(/\b(\d{1,3})\s+(\d{3})\b/g, '$1,$2')

  const nums: number[] = []
  const add = (n: number) => {
    if (Number.isFinite(n) && n >= 1_000 && n <= 50_000_000) nums.push(n)
  }

  for (const m of text.matchAll(/\b(\d{1,3}),(\d{3})\b/g)) {
    add(Number(m[1] + m[2]))
  }
  for (const m of text.matchAll(/\b(\d{1,3}),(\d{3}),(\d{3})\b/g)) {
    add(Number(m[1] + m[2] + m[3]))
  }
  for (const m of text.matchAll(/\b(\d{4,}),(\d{3})\b/g)) {
    add(Number(m[1].slice(-3) + m[2]))
  }
  for (const m of text.matchAll(/\b(\d{5,7})\b/g)) {
    add(Number(m[1]))
  }

  // Explicit: optional icon digit + amount with any separator
  const spaced = raw
    .replace(/\u00A0/g, ' ')
    .match(/\b\d?\s*(\d{2,3})[,.\s](\d{3})\b/)
  if (spaced) add(Number(spaced[1] + spaced[2]))

  if (!nums.length) return undefined
  const haul = nums.filter((n) => n >= 100_000 && n <= 5_000_000)
  return Math.max(...(haul.length ? haul : nums))
}

/** Digit string of the parsed reward (for 8↔9 pass voting). */
function rewardDigitKey(raw: string): string | undefined {
  const n = parseRewardAmount(raw)
  return n != null ? String(n) : undefined
}

function onlyEightNineDiff(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if ((a[i] === '8' && b[i] === '9') || (a[i] === '9' && b[i] === '8')) continue
    return false
  }
  return true
}

/**
 * Pick among OCR passes of the same reward crop.
 * When passes only disagree by 8↔9 (common blur/invert swap), keep the one with more 9s.
 */
export function pickBestRewardText(candidates: string[]): string {
  const useful = candidates.filter((t) => {
    if (!t?.trim()) return false
    const n = parseRewardAmount(t)
    return n != null && n >= 10_000
  })
  if (!useful.length) return candidates.find((t) => t?.trim())?.trim() ?? ''

  // Prefer a reading that has a 9 where another pass only has 8
  let best = useful[0]
  let bestKey = rewardDigitKey(best)!
  let bestNines = (bestKey.match(/9/g) ?? []).length

  for (let i = 1; i < useful.length; i++) {
    const text = useful[i]
    const key = rewardDigitKey(text)
    if (!key) continue
    const nines = (key.match(/9/g) ?? []).length
    if (onlyEightNineDiff(bestKey, key)) {
      if (nines > bestNines) {
        best = text
        bestKey = key
        bestNines = nines
      }
      continue
    }
    // Otherwise keep first useful (pass order: plain sharp → plain smooth → ink)
  }
  return best
}

/**
 * Full-image / loose fallback when reward crop is empty or icon-only.
 * Contract UI often shows the payout with no “aUEC” label — use haul-sized amounts.
 */
export function parseRewardAmountFromFull(raw: string): number | undefined {
  if (!raw || !/\d/.test(raw)) return undefined

  const scrubbed = scrubNonRewardNoise(raw)

  // Optional aUEC if present
  const labeled: number[] = []
  for (const m of scrubbed.matchAll(/([\d,.\s]{3,20})\s*a\s*u\s*e\s*[cg]/gi)) {
    const n = parseRewardAmount(m[1])
    if (n != null) labeled.push(n)
  }
  const labeledHaul = labeled.filter((n) => n >= 100_000 && n <= 5_000_000)
  if (labeledHaul.length) return Math.max(...labeledHaul)

  // No aUEC on screen — largest haul-sized comma/long amount (e.g. 958,250)
  const page = parseRewardAmount(scrubbed)
  if (page != null && page >= 100_000 && page <= 5_000_000) return page
  if (labeled.length) return Math.max(...labeled)
  return page != null && page >= 50_000 ? page : undefined
}

function normalizeDeliverText(objText: string): string {
  return objText
    .replace(/\u00A0/g, ' ')
    .replace(/[|\\]/g, '/')
    // Common OCR: O/o for 0 in “0/126”
    .replace(/\b[oO]\s*\/\s*(\d+)/g, '0/$1')
}

export type DeliverLine = {
  totalScu: number
  commodity: string
  dropRaw: string
  index: number
}

/** All “Deliver 0/N SCU of X to Y” lines (OCR-tolerant), in document order. */
export function parseAllDeliverLines(objText: string): DeliverLine[] {
  const text = normalizeDeliverText(objText)
  const out: DeliverLine[] = []
  const seen = new Set<number>()

  const tryPattern = (re: RegExp) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (seen.has(m.index)) continue
      const totalScu = Number(m[1])
      if (!(totalScu > 0 && totalScu <= 5000)) continue
      seen.add(m.index)
      out.push({
        totalScu,
        commodity: m[2].trim(),
        dropRaw: m[3].replace(/\s+above\b.*/i, '').trim(),
        index: m.index,
      })
    }
  }

  tryPattern(
    /del[il1]ver\s+\d+\s*\/\s*(\d+)\s*scu\s+of\s+(.+?)\s+to\s+([^\n.]+)/gi,
  )
  tryPattern(/del[il1]ver\s+(\d+)\s*scu\s+of\s+(.+?)\s+to\s+([^\n.]+)/gi)
  if (!out.length) {
    // Looser: “0/126 SCU of … to …”
    tryPattern(/\b\d+\s*\/\s*(\d+)\s*scu\s+of\s+(.+?)\s+to\s+([^\n.]+)/gi)
  }

  out.sort((a, b) => a.index - b.index)
  return out
}

/** First deliver line — contract total / commodity / drop when only one leg. */
export function parseDeliverTotalScu(objText: string): {
  totalScu: number
  commodity: string
  dropRaw: string
} | null {
  const first = parseAllDeliverLines(objText)[0]
  if (!first) return null
  return {
    totalScu: first.totalScu,
    commodity: first.commodity,
    dropRaw: first.dropRaw,
  }
}

function toCrateSize(n: number): CrateSize | undefined {
  return (CRATE_SIZES as readonly number[]).includes(n) ? (n as CrateSize) : undefined
}

/** OCR sometimes reads blue “8” as B / & / S — only in SCU crate context. */
function digitizeCrateToken(raw: string): number | undefined {
  const t = raw.trim()
  if (/^\d+$/.test(t)) return Number(t)
  if (/^[bB&]$/.test(t)) return 8
  return undefined
}

/**
 * Max crate from mission info.
 * Strict = phrases safe on full image.
 * Loose (info crop) = also bare “N SCU” — blue OCR often returns only that.
 */
export function parseMaxCrateSize(
  infoText: string,
  opts: { allowLoose?: boolean } = {},
): CrateSize | undefined {
  const all = collectCrateSizes(infoText, opts)
  return all[0]
}

/** All valid crate sizes mentioned (first = best phrase match). */
export function collectCrateSizes(
  infoText: string,
  opts: { allowLoose?: boolean } = {},
): CrateSize[] {
  const text = infoText.replace(/\u00A0/g, ' ')
  const found: CrateSize[] = []
  const add = (token: string) => {
    const n = digitizeCrateToken(token)
    if (n == null) return
    const size = toCrateSize(n)
    if (size != null && !found.includes(size)) found.push(size)
  }

  const strict = [
    /(?:all\s+)?([0-9bB&])\s*scu\s+or\s+smaller/gi,
    /max(?:imum)?\s*(?:container|box|crate)?\s*(?:size)?[:\s]*([0-9bB&])\s*scu/gi,
    /containers?\s+(?:of\s+)?(?:up\s+to\s+)?([0-9bB&])\s*scu\s+or\s+smaller/gi,
  ]
  const loose = [
    /(?:up\s+to|no\s+larger\s+than)\s+([0-9bB&])\s*scu/gi,
    /\b([0-9bB&])\s*scu\b/gi,
  ]

  for (const re of strict) {
    for (const m of text.matchAll(re)) add(m[1])
  }
  if (opts.allowLoose) {
    for (const re of loose) {
      for (const m of text.matchAll(re)) add(m[1])
    }
  }
  return found
}

export type CrateTextSource = {
  text?: string
  /** loose matches allowed (info crops / blue blob) */
  loose?: boolean
  /** weight boost — blue blob / mask reads of the digit */
  weight?: number
}

/**
 * Merge crate readings from plain / blue-mask / blue-blob / full image.
 * Blue “8” is often OCR’d as “4” — if both appear from info crops, prefer 8.
 * Full image only uses strict phrases (avoids random “4 SCU” noise).
 */
export function pickMaxCrateSize(
  sources: CrateTextSource[],
): CrateSize | undefined {
  const scores = new Map<CrateSize, number>()
  const bump = (size: CrateSize, w: number) => {
    scores.set(size, (scores.get(size) ?? 0) + w)
  }

  for (const src of sources) {
    const t = src.text?.trim()
    if (!t) continue
    const w = src.weight ?? 1
    const allowLoose = src.loose === true
    const sizes = collectCrateSizes(t, { allowLoose })
    for (const size of sizes) {
      // Strict-looking phrase in this text gets a bump
      const strictHit = collectCrateSizes(t, { allowLoose: false }).includes(size)
      bump(size, w + (strictHit ? 2 : 0))
    }
  }

  if (!scores.size) return undefined

  const sizes = [...scores.keys()]
  if (sizes.includes(8) && sizes.includes(4)) {
    // Info/blue sources: 8 wins over a soft-misread 4
    const s8 = scores.get(8) ?? 0
    const s4 = scores.get(4) ?? 0
    if (s8 >= s4 - 1) return 8
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
}
