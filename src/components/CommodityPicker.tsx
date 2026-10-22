import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommodityInfo } from '../api/uex'
import { FieldClearButton } from './FieldClearButton'

interface Props {
  commodities: CommodityInfo[]
  value: string
  onChange: (name: string) => void
  idPrefix?: string
}

function matchScore(name: string, q: string): number {
  const n = name.toLowerCase()
  if (n === q) return 0
  if (n.startsWith(q)) return 1
  const idx = n.indexOf(q)
  if (idx >= 0) return 2 + idx
  if (n.split(/\s+/).some((t) => t.startsWith(q))) return 3
  return -1
}

export function CommodityPicker({
  commodities,
  value,
  onChange,
  idPrefix = 'commodity',
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const [categoriesSelected, setCategoriesSelected] = useState<string[]>([])
  const [focused, setFocused] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const q = value.trim().toLowerCase()
  const exactSelected = commodities.some((c) => c.name === value)

  useEffect(() => {
    if (!expanded && !focused) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setExpanded(false)
        setFocused(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false)
        setFocused(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [expanded, focused])

  const closestMatches = useMemo(() => {
    if (!q || exactSelected) return []
    const scored: Array<{ c: CommodityInfo; score: number }> = []
    for (const c of commodities) {
      const score = matchScore(c.name, q)
      if (score < 0) continue
      scored.push({ c, score })
    }
    scored.sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name))
    return scored.slice(0, 8).map((s) => s.c)
  }, [commodities, q, exactSelected])

  const { categories, items, activeSet, matchCount } = useMemo(() => {
    const matchesQuery = (c: CommodityInfo) =>
      !q || matchScore(c.name, q) >= 0 || c.kind.toLowerCase().includes(q)

    const queried = commodities.filter(matchesQuery)
    const counts = new Map<string, number>()
    for (const c of queried) {
      counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1)
    }
    const categories = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([kind, count]) => ({ kind, count }))

    const available = new Set(categories.map((c) => c.kind))
    const activeSet = categoriesSelected.filter((k) => available.has(k))

    const items = (
      activeSet.length
        ? queried.filter((c) => activeSet.includes(c.kind))
        : queried
    ).sort((a, b) => {
      if (!q) return a.name.localeCompare(b.name)
      return (
        matchScore(a.name, q) - matchScore(b.name, q) ||
        a.name.localeCompare(b.name)
      )
    })

    return {
      categories,
      items,
      activeSet,
      matchCount: queried.length,
    }
  }, [commodities, categoriesSelected, q])

  const showClosest = !expanded && focused && closestMatches.length > 0

  function pick(name: string, kind?: string) {
    onChange(name)
    if (kind) {
      setCategoriesSelected((prev) =>
        prev.includes(kind) ? prev : [...prev, kind],
      )
    }
    setExpanded(false)
    setFocused(false)
  }

  function toggleCategory(kind: string) {
    setCategoriesSelected((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    )
  }

  return (
    <div className="commodity-picker field" ref={rootRef}>
      <span>Commodity</span>
      <div className="commodity-picker-bar">
        <div className="field-input-wrap">
          <input
            id={`${idPrefix}-search`}
            type="text"
            className="commodity-picker-search"
            value={value}
            placeholder="Type to match…"
            onChange={(e) => {
              onChange(e.target.value)
              setFocused(true)
            }}
            onFocus={() => setFocused(true)}
            autoComplete="off"
            spellCheck={false}
          />
          <FieldClearButton
            visible={Boolean(value.trim())}
            label="Clear commodity"
            onClear={() => {
              onChange('')
              setFocused(true)
            }}
          />
        </div>
        <button
          type="button"
          className={`commodity-picker-toggle ghost${expanded ? ' open' : ''}`}
          aria-expanded={expanded}
          aria-controls={`${idPrefix}-browser`}
          title={expanded ? 'Hide commodity browser' : 'Browse by category'}
          onClick={() => {
            setExpanded((v) => !v)
            setFocused(false)
          }}
        >
          ▾
        </button>
      </div>

      {showClosest && (
        <ul
          className="commodity-picker-closest"
          role="listbox"
          aria-label="Closest matches"
        >
          {closestMatches.map((c) => (
            <li key={c.name}>
              <button
                type="button"
                role="option"
                aria-selected={value === c.name}
                className={value === c.name ? 'active' : undefined}
                onClick={() => pick(c.name, c.kind)}
              >
                {c.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {expanded && (
        <div
          id={`${idPrefix}-browser`}
          className="commodity-picker-split"
          role="group"
          aria-label="Commodity browser"
        >
          <ul className="commodity-picker-cats" aria-label="Categories">
            <li>
              <button
                type="button"
                className={!activeSet.length ? 'active' : undefined}
                onClick={() => setCategoriesSelected([])}
              >
                All
                <em>{matchCount}</em>
              </button>
            </li>
            {categories.map(({ kind, count }) => {
              const on = activeSet.includes(kind)
              return (
                <li key={kind}>
                  <button
                    type="button"
                    className={on ? 'active' : undefined}
                    aria-pressed={on}
                    onClick={() => toggleCategory(kind)}
                  >
                    {kind}
                    <em>{count}</em>
                  </button>
                </li>
              )
            })}
          </ul>
          <ul className="commodity-picker-items" aria-label="Commodities">
            {items.length === 0 && (
              <li className="commodity-picker-empty">No matches</li>
            )}
            {items.map((c) => (
              <li key={c.name}>
                <button
                  type="button"
                  className={value === c.name ? 'active' : undefined}
                  onClick={() => pick(c.name, c.kind)}
                >
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
