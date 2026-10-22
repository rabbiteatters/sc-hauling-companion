import { useEffect, useMemo, useRef, useState } from 'react'
import { locationLabel } from '../store/catalog'
import type { Location } from '../types'
import { FieldClearButton } from './FieldClearButton'

interface Props {
  locations: Location[]
  value: string
  onChange: (locationId: string) => void
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

function bodyCategory(loc: Location): string {
  const body = loc.body || 'Unknown'
  if (loc.system === 'pyro') return `Pyro · ${body}`
  if (loc.system === 'stanton') return body
  if (loc.system) return `${loc.system} · ${body}`
  return body
}

function locHay(loc: Location): string {
  return `${loc.shortName} ${loc.name} ${loc.body} ${loc.system ?? ''} ${(loc.aliases ?? []).join(' ')}`
}

export function StartLocationPicker({
  locations,
  value,
  onChange,
  idPrefix = 'start-loc',
}: Props) {
  const selected = locations.find((l) => l.id === value)
  const selectedLabel = selected ? locationLabel(selected.id) : ''
  const [expanded, setExpanded] = useState(false)
  const [bodiesSelected, setBodiesSelected] = useState<string[]>([])
  const [focused, setFocused] = useState(false)
  const [query, setQuery] = useState(selectedLabel)
  const rootRef = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()

  useEffect(() => {
    if (!focused) setQuery(selectedLabel)
  }, [value, selectedLabel, focused])

  useEffect(() => {
    if (!expanded && !focused) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setExpanded(false)
        setFocused(false)
        setQuery(selectedLabel)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false)
        setFocused(false)
        setQuery(selectedLabel)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [expanded, focused, selectedLabel])

  const closestMatches = useMemo(() => {
    if (!q || (selected && selectedLabel.toLowerCase() === q)) return []
    const scored: Array<{ loc: Location; score: number }> = []
    for (const loc of locations) {
      const label = locationLabel(loc.id)
      const score = matchScore(label, q)
      const hayHit = locHay(loc).toLowerCase().includes(q)
      if (score < 0 && !hayHit) continue
      scored.push({ loc, score: score >= 0 ? score : 5 })
    }
    scored.sort(
      (a, b) =>
        a.score - b.score ||
        locationLabel(a.loc.id).localeCompare(locationLabel(b.loc.id)),
    )
    return scored.slice(0, 8).map((x) => x.loc)
  }, [locations, q, selected, selectedLabel])

  const { categories, items, activeSet, matchCount } = useMemo(() => {
    const matchesQuery = (loc: Location) =>
      !q ||
      matchScore(locationLabel(loc.id), q) >= 0 ||
      locHay(loc).toLowerCase().includes(q)

    const queried = locations.filter(matchesQuery)
    const counts = new Map<string, number>()
    for (const loc of queried) {
      const cat = bodyCategory(loc)
      counts.set(cat, (counts.get(cat) ?? 0) + 1)
    }
    const categories = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([kind, count]) => ({ kind, count }))

    const available = new Set(categories.map((c) => c.kind))
    const activeSet = bodiesSelected.filter((k) => available.has(k))

    const items = (
      activeSet.length
        ? queried.filter((loc) => activeSet.includes(bodyCategory(loc)))
        : queried
    ).sort((a, b) => {
      const la = locationLabel(a.id)
      const lb = locationLabel(b.id)
      if (!q) return la.localeCompare(lb)
      return matchScore(la, q) - matchScore(lb, q) || la.localeCompare(lb)
    })

    return { categories, items, activeSet, matchCount: queried.length }
  }, [locations, bodiesSelected, q])

  const showClosest = !expanded && focused && closestMatches.length > 0
  const canClear = Boolean(query.trim() || value)

  function pick(loc: Location) {
    onChange(loc.id)
    setQuery(locationLabel(loc.id))
    const cat = bodyCategory(loc)
    setBodiesSelected((prev) => (prev.includes(cat) ? prev : [...prev, cat]))
    setExpanded(false)
    setFocused(false)
  }

  function clear() {
    setQuery('')
    onChange('')
    setFocused(true)
  }

  function toggleBody(kind: string) {
    setBodiesSelected((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    )
  }

  return (
    <div className="commodity-picker start-location-picker field" ref={rootRef}>
      <span>Starting location (UEX)</span>
      <div className="commodity-picker-bar">
        <div className="field-input-wrap">
          <input
            id={`${idPrefix}-search`}
            type="text"
            className="commodity-picker-search"
            value={query}
            placeholder="Type to match…"
            onChange={(e) => {
              setQuery(e.target.value)
              setFocused(true)
            }}
            onFocus={() => {
              setFocused(true)
              setQuery(selectedLabel)
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <FieldClearButton visible={canClear} onClear={clear} label="Clear location" />
        </div>
        <button
          type="button"
          className={`commodity-picker-toggle ghost${expanded ? ' open' : ''}`}
          aria-expanded={expanded}
          aria-controls={`${idPrefix}-browser`}
          title={expanded ? 'Hide location browser' : 'Browse by body'}
          onClick={() => {
            setExpanded((v) => !v)
            setFocused(false)
            if (expanded) setQuery(selectedLabel)
          }}
        >
          ▾
        </button>
      </div>

      {selected && !focused && !expanded && (
        <p className="ship-picker-meta hint tight">
          {bodyCategory(selected)}
        </p>
      )}

      {showClosest && (
        <ul
          className="commodity-picker-closest"
          role="listbox"
          aria-label="Closest matches"
        >
          {closestMatches.map((loc) => (
            <li key={loc.id}>
              <button
                type="button"
                role="option"
                aria-selected={value === loc.id}
                className={value === loc.id ? 'active' : undefined}
                onClick={() => pick(loc)}
              >
                {locationLabel(loc.id)}
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
          aria-label="Location browser"
        >
          <ul className="commodity-picker-cats" aria-label="Bodies">
            <li>
              <button
                type="button"
                className={!activeSet.length ? 'active' : undefined}
                onClick={() => setBodiesSelected([])}
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
                    onClick={() => toggleBody(kind)}
                  >
                    {kind}
                    <em>{count}</em>
                  </button>
                </li>
              )
            })}
          </ul>
          <ul className="commodity-picker-items" aria-label="Locations">
            {items.length === 0 && (
              <li className="commodity-picker-empty">No matches</li>
            )}
            {items.map((loc) => (
              <li key={loc.id}>
                <button
                  type="button"
                  className={value === loc.id ? 'active' : undefined}
                  onClick={() => pick(loc)}
                >
                  {locationLabel(loc.id)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
