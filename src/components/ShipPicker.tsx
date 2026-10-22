import { useEffect, useMemo, useRef, useState } from 'react'
import type { Ship } from '../types'
import { FieldClearButton } from './FieldClearButton'

interface Props {
  ships: Ship[]
  value: string
  onChange: (shipId: string) => void
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

function shipLabel(s: Ship): string {
  return `${s.name} — ${s.cargoScu} SCU`
}

export function ShipPicker({
  ships,
  value,
  onChange,
  idPrefix = 'ship',
}: Props) {
  const selected = ships.find((s) => s.id === value)
  const [expanded, setExpanded] = useState(false)
  const [makersSelected, setMakersSelected] = useState<string[]>([])
  const [focused, setFocused] = useState(false)
  const [query, setQuery] = useState(selected?.name ?? '')
  const rootRef = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()

  useEffect(() => {
    if (!focused) setQuery(selected?.name ?? '')
  }, [value, selected?.name, focused])

  useEffect(() => {
    if (!expanded && !focused) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setExpanded(false)
        setFocused(false)
        setQuery(selected?.name ?? '')
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false)
        setFocused(false)
        setQuery(selected?.name ?? '')
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [expanded, focused, selected?.name])

  const closestMatches = useMemo(() => {
    if (!q || (selected && selected.name.toLowerCase() === q)) return []
    const scored: Array<{ s: Ship; score: number }> = []
    for (const s of ships) {
      const nameScore = matchScore(s.name, q)
      const makerHit = s.manufacturer.toLowerCase().includes(q)
      if (nameScore < 0 && !makerHit) continue
      scored.push({ s, score: nameScore >= 0 ? nameScore : 5 })
    }
    scored.sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name))
    return scored.slice(0, 8).map((x) => x.s)
  }, [ships, q, selected])

  const { categories, items, activeSet, matchCount } = useMemo(() => {
    const matchesQuery = (s: Ship) =>
      !q ||
      matchScore(s.name, q) >= 0 ||
      s.manufacturer.toLowerCase().includes(q) ||
      String(s.cargoScu).includes(q)

    const queried = ships.filter(matchesQuery)
    const counts = new Map<string, number>()
    for (const s of queried) {
      const maker = s.manufacturer.trim() || 'Unknown'
      counts.set(maker, (counts.get(maker) ?? 0) + 1)
    }
    const categories = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([kind, count]) => ({ kind, count }))

    const available = new Set(categories.map((c) => c.kind))
    const activeSet = makersSelected.filter((k) => available.has(k))

    const items = (
      activeSet.length
        ? queried.filter((s) =>
            activeSet.includes(s.manufacturer.trim() || 'Unknown'),
          )
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
  }, [ships, makersSelected, q])

  const showClosest = !expanded && focused && closestMatches.length > 0

  function pick(ship: Ship) {
    onChange(ship.id)
    setQuery(ship.name)
    setMakersSelected((prev) => {
      const maker = ship.manufacturer.trim() || 'Unknown'
      return prev.includes(maker) ? prev : [...prev, maker]
    })
    setExpanded(false)
    setFocused(false)
  }

  function toggleMaker(kind: string) {
    setMakersSelected((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    )
  }

  return (
    <div className="commodity-picker ship-picker field" ref={rootRef}>
      <span>Ship (UEX)</span>
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
              setQuery(selected?.name ?? '')
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <FieldClearButton
            visible={Boolean(query.trim() || value)}
            label="Clear ship"
            onClear={() => {
              setQuery('')
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
          title={expanded ? 'Hide ship browser' : 'Browse by manufacturer'}
          onClick={() => {
            setExpanded((v) => !v)
            setFocused(false)
            if (expanded) setQuery(selected?.name ?? '')
          }}
        >
          ▾
        </button>
      </div>

      {selected && !focused && !expanded && (
        <p className="ship-picker-meta hint tight">
          {selected.manufacturer} · {selected.cargoScu} SCU
        </p>
      )}

      {showClosest && (
        <ul
          className="commodity-picker-closest"
          role="listbox"
          aria-label="Closest matches"
        >
          {closestMatches.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected={value === s.id}
                className={value === s.id ? 'active' : undefined}
                onClick={() => pick(s)}
              >
                {shipLabel(s)}
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
          aria-label="Ship browser"
        >
          <ul className="commodity-picker-cats" aria-label="Manufacturers">
            <li>
              <button
                type="button"
                className={!activeSet.length ? 'active' : undefined}
                onClick={() => setMakersSelected([])}
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
                    onClick={() => toggleMaker(kind)}
                  >
                    {kind}
                    <em>{count}</em>
                  </button>
                </li>
              )
            })}
          </ul>
          <ul className="commodity-picker-items" aria-label="Vehicles">
            {items.length === 0 && (
              <li className="commodity-picker-empty">No matches</li>
            )}
            {items.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={value === s.id ? 'active' : undefined}
                  onClick={() => pick(s)}
                >
                  {shipLabel(s)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
